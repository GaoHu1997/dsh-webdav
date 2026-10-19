# 0016 — 找 pnpm 时先查 PATH，让「这台电脑没有 pnpm」说成那句为它写的话

- 状态：已接受
- 日期：2026-10-16（全面检测阶段发现并修复）

## 背景

`src/install.ts` 的 `installPlugins()` 按 `pnpmCandidates()` 的顺序找 pnpm：`$DSH_PNPM` → `$DSH_RESOURCES_DIR/runtime/pnpm/bin/pnpm.cjs` → 裸名 `pnpm.cmd`（win32）/ `pnpm`。带路径分隔符的候选会先 `exists()` 查一遍，裸名不会。

`run()` 用 `spawn(command, args, { shell: command.endsWith('.cmd') })`。在 Windows 上裸名 `pnpm.cmd` 因此走 `shell: true`，而**一个找不到命令的 shell 照样会启动、照样会退出**——它只是在 stderr 上抱怨一句，然后以非零码退出。于是 `run()` 正常 resolve 了退出码，`started` 被置为 `true`，`lastCause` 永远是 `undefined`：

```ts
code = await run(candidate, [...], paths.profileDir, env, logFile)
started = true
```

而函数末尾那句专为这个处境写的提示，被 `started === true` 挡在后面，任何一次真跑都不会到达：

```ts
if (!started) {
  if (lastCause !== undefined) { … }
  throw new Error(
    'pnpm is not on this computer, so the plugins a sync brings in cannot be installed: install pnpm, or set DSH_PNPM to the pnpm executable',
  )
}
```

实测（`.pkgcheck/install-probe.mjs`，清空 `DSH_PNPM` 与 `DSH_RESOURCES_DIR`、把 `PATH` 指向一个空目录后调用 `installPlugins`）：

```
RESOLVED (no throw): {"ok":false,"output":"'pnpm.cmd' is not recognized as an internal or external command,\r\noperable program or batch file."}
```

即用户看到的是 shell 在抱怨一个他从没听说过的文件名，而不是「装 pnpm，或者把 `DSH_PNPM` 指向 pnpm 可执行文件」。这个提示是这次安装唯一可操作的信息，却恰恰在最需要它的场景下不可达。同时 `lastCause`（那条 `running pnpm in … failed: …` 分支）也因此永远不会被走到。

这条路径此前**没有任何测试**：`grep installPlugins|src/install tests/` 零命中，`tests/install.spec.ts` 不存在。

## 决策

在 `src/install.ts` 里加两件事，并在候选循环里用它：

1. `onPath(name, env): Promise<boolean>`——把 `PATH`（`env.Path` 兜底，Windows 的变量名大小写不定）按平台分隔符拆开，逐目录查 `name` 本身；Windows 上还按 `PATHEXT`（缺省 `.COM;.EXE;.BAT;.CMD`）把扩展名补上去查去掉扩展名后的基名。
2. `missingCommand(cause): boolean`——`cause.code === 'ENOENT'`。

循环里带分隔符的候选照旧 `exists()`，**裸名改成先 `onPath()`**：查不到就 `continue`，不 spawn。捕获到的错误若是 `missingCommand`，不记 `lastCause`——shell 为「文件不存在」说的话正是在这个处境下要替换掉的东西，让它落到那句写好的提示上；别的失败（权限、超时、pnpm 自己崩了）照旧记 `lastCause` 并被原样转述。

理由是**判定应该发生在 spawn 之前**：`spawn` 之后要区分「命令不存在」和「命令存在但失败」，就得去解析各平台 shell 的措辞，而那正是要避免的东西。查一次 `PATH` 是同一件事的确定版本，而且它把「没有任何候选」这个状态变成一个可测的事实。

被否决的备选：

- **只靠 `cause.code === 'ENOENT'`，不查 PATH。** 在 Windows 上不成立：`shell: true` 的 spawn 不会给 ENOENT，它给的是一个正常退出的 `cmd.exe`。这是本次缺陷的成因本身。
- **给 `spawn` 加 `shell: false`。** 会改掉 `.cmd` 在 Windows 上本来需要的调用方式，等于用一个平台问题换另一个。
- **把 `started` 的条件改成「退出码看起来像命令找不到」。** 又要解析 shell 措辞，且各平台措辞不同，还要防误判（pnpm 自己也可能输出类似文字）。
- **匹配 shell 的错误文本（`'is not recognized'`）。** 与上一条同理，且依赖语言与平台。
- **什么都不改，只把提示改成「看看 pnpm 的输出」。** 那等于承认那句为「没有 pnpm」写的句子是死代码，并让用户去读一句他看不懂的 shell 报错。
- **删掉 `onPath` 的 `PATHEXT` 处理，只查基名。** Windows 上 `pnpm` 实际是 `pnpm.cmd`，不补扩展名就永远查不到，反倒把「没有 pnpm」误报成「有 pnpm 但它跑了」——正是要修的错误。

## 影响

正面：

- 「这台电脑没有 pnpm」现在会说成那句为它写的话，附上两个可操作的出路。
- `lastCause` 那条分支重新可达：pnpm 存在但启动失败（权限等）时，报的是 `running pnpm in <profile> failed: <原因>`。
- 少一次必然失败的 spawn，以及它留在一份日志里的 shell 噪声。
- `src/install.ts` 从零测试变成有测试：新增 `tests/install.spec.ts` 六个用例，用真的会写 stdout、真的会 `mkdir` 出包、真的以指定码退出的 pnpm 替身驱动，覆盖「装了→ok」「退出码 0 但仍有缺→不 ok 并点名」「非零码且有缺→转述它的话」「非零码但没缺→仍是 ok（退出码不是判据，`stillMissing` 才是）」「没有 pnpm→那句提示」「`DSH_PNPM` 指向跑不起来的路径→同一句提示」。

负面与代价：

- `onPath()` 每次安装会把 `PATH` 上的目录逐个 `stat`（Windows 上再乘扩展名个数）。代价是几十次 `stat`，相对于一次 pnpm 安装可以忽略，但它是**猜**：`PATHEXT` 为空或异常时仍可能漏判，此时退回原来的行为（spawn 后转述 shell 的话），不会更糟。
- 「命令不存在」与「命令存在但退出码非零」的区分，从此依赖 `onPath` 的判断而不是内核的 ENOENT。若 `PATH` 在本次进程之外被改（长时间运行后被外部改动），判断会过时——但此刻 `spawn` 用的也是同一份 `process.env.PATH`，二者一致。
- `missingCommand` 会吞掉 ENOENT 型失败，使 `lastCause` 保持 `undefined`。若某个真 pnpm 以 ENOENT 形式失败（实际不可能：ENOENT 就是「文件不在」），用户会看到那句提示而非 pnpm 的输出。这条是刻意取舍。
- 仍然只覆盖「找不到 pnpm」；「找到了但装不上」依旧靠 `stillMissing()` 事后复查，用户看到的仍是 pnpm 自己的话。

## 验证

- `.pkgcheck/install-probe.mjs` 修复前 7/10，修复后 **10/10**（其自身两个失败是探针的 bug，已一并修正：临时 profile 前缀曾与日志目录通配 `dsh-webdav-install-` 撞名、`END` 断言忽略了替身随后写 stderr 的那一行）。
- `tests/install.spec.ts` 新增 6 例，全通过。
- 全量套件 **166 → 172 例**（7 文件：engine 47、dav 37、store 27、state 23、crypto 22、index 10、install 6）。
- `pnpm run typecheck` exit 0；`pnpm run build:all` exit 0。
