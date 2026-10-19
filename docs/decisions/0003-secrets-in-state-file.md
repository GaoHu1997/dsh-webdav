# 0003 — 密码与口令存 `.dsh-webdav-sync/sync.json`(0600)，绝不进 `cordis.patch.yml`

- 状态：已接受
- 日期：2026-10-16（本仓库首次提交）

## 背景

DSH 插件的配置有两条现成的路可走：

1. **composition entry 的 `config`**，也就是写在 profile 的 `cordis.patch.yml` 里那一行 loader row 的配置。
2. **插件自己的文件**，在 profile 目录下另开一个目录。

对本插件来说，第一条路有一个致命的性质：**`cordis.patch.yml` 本身就是被同步的四份之一**（`patch` 份，见 [0005](0005-four-parts-and-plugin-exception.md)）。WebDAV 密码如果放在 composition 配置里，下一个同步会把它连同其它 patch 行一起打包、加密、上传到服务器。

而且这不只是「多传一次」的问题：上传之后，这份配置就同时存在于两台（或更多）电脑的 patch 文件里，且会在任何一次 `sync/` 留档里再复制一份。任何一次「我在别处贴一下我的 patch 看看哪里错了」都会顺手把它带出去。

口令的处境更微妙一点：口令是加密用的密钥材料，它一旦进了会被同步的文件，等于把自己锁进自己保管的保险箱——另一台电脑拿到文件的同时也拿到了打开它的口令，本机加密这一层就只剩下对服务器有效了。

被否决的备选：

- **写进 `cordis.patch.yml` 的 loader row config**：如上，会被同步上传。
- **只放在浏览器 localStorage**：Host 半边（真正做同步的那一半）读不到；而且换浏览器就丢。
- **每次同步都在卡片上重新输入**：与 `autoEvery` 自动同步直接冲突——定时器没有人在旁边打字。
- **交给操作系统的钥匙串**：需要引入平台相关的原生依赖（本插件运行时依赖只有 `yaml`），且在 Linux 无头环境下没有稳定答案。

## 决策

WebDAV 地址、用户名、密码、口令，以及四个份开关和自动同步间隔，全部写进插件自己的配置文件：

```
<profileDir>/.dsh-webdav-sync/sync.json      mode 0600
<profileDir>/.dsh-webdav-sync/               mode 0700
```

理由写在 `src/state.ts` 的文件头与 `src/index.ts` 里：

```
 * the configuration (which holds the server password and the passphrase, so it is
 * written 0600), the sync state, and a cached copy of what the server held when
 * it was last read.
```

```ts
// Nothing about the WebDAV account is stored in the composition: the profile
// patch is itself one of the things that travels, so a password put there would
// be uploaded by the next sync.
```

配套措施：

- 写文件走 `writeAtomic(file, data, 0o600)`（先写同目录临时文件再 rename），并且 `chmod` 一次以对抗 umask；状态目录用 `mkdir(..., { mode: 0o700 })` 加 `chmod(0o700)`（`src/state.ts:107-115`）。
- `sync-state.json` 不含密钥，但会指名一个文件夹路径，**也**按 0600 写（`src/state.ts:102-104`）。
- 缓存正文 `sync-server.dshsync` 是**密文**，同样 0600。
- `sync/` 留档目录下每个文件也都是 0600（`keepAside`，`src/store.ts:391`）。
- 插件自己的 loader 行在收集 patch 份时被排除（`SELF_ID = 'dsh-webdav-sync'`，`src/store.ts:37,163`），所以这一行不会在机器之间来回跑——composition 配置里有什么都不会被这份插件上传。
- **口令不下发浏览器**：卡片拿到的是 `ConfigView`，只有 `passwordSet` / `passphraseSet` 两个布尔值。表单留空提交的含义是「沿用已存的那个」而不是清空（`ConfigureBody` 的契约，`src/index.ts:129-140`），要清空得用「关闭同步」。
- `rememberPassword = false` 时，`configure()` 在保存前把 `next.password = ''`（`src/index.ts:163`），密码只在本次进程内使用。注意此时**口令仍然会写盘**——它必须留在盘上，否则自动同步无从加密。

## 影响

正面：

- 密码和口令没有一条路径会到达服务器：既不进 patch，也不进浏览器，也不进日志（错误消息里从不回显口令内容，只说你该换个口令）。
- 卡片永远不需要「读回」一个密钥，所以前端不存在泄漏点；`passwordSet` / `passphraseSet` 两个布尔值就是这个界面与密钥之间全部的接触面。
- 文件权限与「原子写」的临时文件写在同一目录，避免了临时文件落在更宽松的 `/tmp` 上再被搬运。

负面：

- **密钥在磁盘上是可恢复的明文**（对能读该用户 profile 目录的进程而言）。这是「自动同步必须能无人值守地加密」的直接代价；0600 是给同机其它用户设的门槛，不是给同用户下的恶意进程设的。
- `rememberPassword` 只能管住密码，管不住口令——用户如果以为关掉它就连口令也不落盘，会是一个误解。代码里没有更细的开关。
- 换 profile 目录或换机器时这些文件不跟着走（它们不在被同步的分片里），所以每台新机器都要重新填一次地址、密码与口令。
- 目录名 `.dsh-webdav-sync` 是硬编码的（`STATE_DIR_NAME`，`src/paths.ts:37`），profile 目录下必然多出一个隐藏目录。
