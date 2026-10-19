# 0010 — pnpm 子进程的输出写文件描述符而不是管道

- 状态：已接受
- 日期：2026-10-16（本仓库首次提交）

## 背景

装上「同步过来的插件声明」需要在本机跑 `pnpm install`。这是一个可能跑几分钟、会输出几百行文字的长期子进程，而且它必须把输出给用户看——装失败时 pnpm 说的话就是全部诊断信息。

Node 里最自然的写法是管道：

```ts
spawn(cmd, args, { stdio: 'pipe' })
child.stdout.on('data', chunk => output += chunk)
```

但本插件运行在 **DSH 的文件沙箱**里，而沙箱会拒绝「打开命名管道」这个操作。在这一类受限模式下，用默认 `stdio: 'pipe'` 起的子进程会直接以 `EPERM` 失败，而 `stdio: 'inherit'` 或 `stdio: 'ignore'` 起的能正常工作。也就是说，问题不在「读输出」这个意图上，而在**管道这种 IPC 机制**上。

同时还有几个次要约束：

- 输出可能很长，全留在内存里没意义——用户真正看的是**最后几十行**（通常错误就在那里）。
- 子进程可能挂住（等 registry、等交互式提示），需要一个上限，而不是永远等下去。
- 关掉 pnpm 的交互式 TUI：`--reporter append-only` 是给它一个适合被重定向到文件的输出模式。
- 临时日志文件必须被清掉，哪怕中间抛了异常。

## 决策

**输出重定向到一个真实的、已打开的日志文件描述符。** `src/install.ts:152-190` 的 `run()`：

```ts
  const handle = await open(logFile, 'a')
  try {
    const child = spawn(command, args, {
      cwd,
      env,
      // The output goes to an open file descriptor rather than a pipe: a pipe is
      // a restricted operation inside dsh's file sandbox, and a file descriptor
      // always works. The tail of the file is its own record, and it is what the
      // card shows anyway.
      stdio: ['ignore', handle.fd, handle.fd],
      windowsHide: true,
      shell: command.endsWith('.cmd'),
    })
```

配套的常量与行为：

| 决策 | 值 / 位置 | 为什么 |
| --- | --- | --- |
| 日志落在哪 | `mkdtemp(join(tmpdir(), 'dsh-webdav-install-'))` 下的 `pnpm.log` | 一次性目录，不污染 profile |
| 超时 | `INSTALL_TIMEOUT_MS = 10 * 60 * 1000` | 十分钟是「慢 registry」与「挂住了」的分界；超时杀子进程 |
| 给用户看多少 | `TAIL_CHARS = 4000` | 只说末尾；错误在末尾 |
| 非零退出 | **不抛异常** | 卡片展示 pnpm 说过的话，用户自己判断 |
| 环境 | `{ ...process.env, CI: '1' }` 且删除 `npm_config_prefix` | CI 抑制交互提示；`npm_config_prefix` 会让 pnpm 往一个不对的地方装 |
| 交互 shell | 仅 `.cmd` 走 shell | Windows 上直接 spawn `.cmd` 会失败（`EINVAL`）；但不要给所有命令套 shell |
| 窗口 | `windowsHide: true` | 不要闪一个控制台窗口 |
| stdin | `'ignore'` | pnpm 不该等任何人打字；等不到输入就直接失败，比挂十分钟好 |
| 清理 | `finally` 里 `rm(tempDir, { recursive: true, force: true })` | 无论成功、失败还是超时都不留垃圾 |

**可执行文件按「谁最了解这个 profile」的顺序找**（`pnpmCandidates(env)`，`src/install.ts:42-53`）：

1. `$DSH_PNPM`——用户显式指定，永远优先。
2. `$DSH_RESOURCES_DIR/runtime/pnpm/bin/pnpm.cjs`——**DSH 自带的那个 pnpm**，注释说明「that is the version the profile's lockfile was written by」。用一个不同版本的 pnpm 去改一个别人写的 lockfile，是会产生无意义 diff 的。
3. `pnpm.cmd`（Windows）/ `pnpm`（其它）。

路径型候选（第 2 种）**先检查存在性**，不存在就跳到下一个，而不是起一个必然失败的进程（`src/install.ts` 的 `run` 里对含路径分隔符的候选做 `existsSync`）。一个都没找到时抛的是可操作的消息：

```
pnpm is not on this computer, so the plugins a sync brings in cannot be installed:
install pnpm, or set DSH_PNPM to the pnpm executable
```

**结果分三种，各自说清楚**（`installPlugins` 的收尾）：

- 非零退出且仍缺包 → `{ ok: false, output: 'pnpm exited with N' 或输出尾巴 }`
- 退出码为零但仍缺包 → `{ ok: false, output: 'pnpm finished, but these are still not installed: …' }`——这一条很重要：pnpm 成功不等于声明里的包真的装上了（workspace 配置、registry 镜像、`file:` 依赖都可能让它静默跳过）。
- 都齐了 → `{ ok: true, output: 尾巴 或 'pnpm finished with nothing to report' }`

判断「仍缺」用的是**重新读一遍 profile 的 `package.json`** 再和 `node_modules` 顶层目录比对（`stillMissing()`），而不是相信 pnpm 的退出码，也不是相信内存在跑安装之前拍的快照。

## 影响

正面：

- 在 DSH 的文件沙箱下能工作——这是这条决策存在的全部理由。
- 日志是磁盘上的真实文件：进程被强杀、超时被杀、Node 崩了，文件都还在（在 `finally` 删掉之前），而管道里的内容会随进程一起消失。
- 尾部截断让 UI 只渲染 4000 字符，几百行输出不会变成一个卡住的文本框。
- 十分钟上限 + `stdin: 'ignore'` + `CI=1` 三重保证「等不到输入就挂住」不会发生。
- 优先用 DSH 自带的 pnpm，减少 lockfile 被不同版本重写的概率。
- 「重新读一遍再看还缺什么」让成功判定基于事实而不是退出码。

负面：

- **临时文件是必需的中转**：多了一次磁盘 IO，且需要一条可靠的清理路径。清理放在 `finally`，但如果进程本身被 `SIGKILL`，`dsh-webdav-install-*` 目录会留在系统临时目录里。
- **超时是按整个进程算的，不是按「没有输出」算的**。一个正在下载大包、一直有输出的安装也会在十分钟时被杀掉；反过来，一个安静地挂住的进程要等满十分钟。
- **`TAIL_CHARS = 4000` 会截掉开头**，而某些失败的解释（比如「你用的是另一份 lockfile」）出现在开头。
- 找 pnpm 的策略里，Windows 的 `.cmd` 需要 `shell: true`，这带来一层命令拼接；因为参数都是本插件自己写死的常量（`['install', '--reporter', 'append-only']`），注入面是零，但这个前提不会写在类型里。
- 安装是同步阻塞卡片的一个动作（`CardBusy` 里有 `'install'`），没有进度条——用户在十分钟内看到的是「处理中…」，直到有输出尾巴为止。
