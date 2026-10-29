# 0078 — 服务器上没有文件就是没有文件：备份被删除或改名后重新上传，不再拿缓存或旧名顶替

- 状态：`已接受`
- 日期：2026-10-29
- 接续：[0076](0076-audit-fixes-fourth-pass.md) 的第四轮审查（同一轮里顺带发现并修复，编号排在其后）

## 背景

用户在另一台电脑上把服务器里的备份文件删掉或改名之后，本机的同步一直报告「已是最新」，备份却再也不回来。查下去是同一件事的两个入口，都是「服务器上没有这个文件」被读成了别的意思：

1. **`openRemote` 拿本地缓存顶替服务器的空缺**（`src/engine.ts`）。旧代码 `data = await cached(paths, state.sum)`：服务器返回 404（文件被删）时，它退回读本地的 `sync-server.dshsync`（上一次上传的留档），于是每一份的哈希都和上次一样 —— `pushNeeded` 永远为假，卡片永远显示「已是最新」，而服务器上那个文件是真的没了。缓存只是**本机自己上一次上传的留档**，它证明不了服务器上还有东西。

2. **`dav.ts` 读旧名文件时把条件头也带了过去**。文件改名后（[0035](0035-backup-suffix-prop.md) 把远端名换过一次），旧名字下可能还留着同一份备份，读它是为了不让本机把自己的配置默默推上去盖掉别人的。但旧代码复用了为新名字构造的 `If-None-Match`/`If-Modified-Since`：服务器对旧名字回答 304（「还是上次那个」），`readAt` 就返回「未修改、无正文」，`openRemote` 因此拿到一份**没有正文**的远端，同样读成「服务器上有一份和上次一样的」，于是又是一次「已是最新」，而那可能是本机上一次改名前的旧文件。

两条都以「同步说没事可做，而备份不在了」告终：前者是文件被删，后者是文件被改名而旧名下只剩一个陈旧的 304。

## 决策

### 一、服务器没有正文，就是没有文件

`openRemote` 里去掉 `cached()` 的兜底，改成 `read.data` 为空即认为空：

```ts
// A server with no file is a server with no file.
const data = read.data
if (data === undefined) return empty
```

`empty` 意味着 `remote.empty === true`、`hashes` 为空 —— 合并循环因此把本机的每一份都当作首次同步的「推送」，备份重新上传。缓存副本 `sync-server.dshsync` 仍然在**别的地方**使用（「本机改过、服务器说未修改」的那次合并，[0004](0004-single-remote-file.md) 定的优化），它只是不再**顶替**服务器的空缺。

否决「缓存存在就说明服务器上应该有，提示用户检查」：缓存不是证据（[0024](0024-adopting-server-keeps-local.md) 已经为同一个理由否决过一次 —— 整个 profile 目录被复制过来时缓存会跟着一起走）。服务器答 404 就是 404，本机该做的是把自己那一份重新传上去。

### 二、读旧名文件不带条件头

`dav.get()` 里读旧名字时显式丢掉条件头，用空请求头与 `undefined` 的基线：

```ts
const legacy = await this.readAt(this.url(REMOTE_FOLDER, LEGACY_REMOTE_FILE), {}, undefined)
return legacy === undefined ? { version: {} } : { ...legacy, notModified: false, version: {} }
```

`{ ...legacy, notModified: false }` 是关键：即便服务器真的对旧名字回答了一次 304，这里也按「有正文、要合并」处理，因为这次读的目的就是把旧名下的**实际内容**拿到手 —— 一次 304 只说明「和本机上次读新名字时那个 ETag 一样」，而这个 ETag 属于新名字，不能拿来证明旧名下那份文件是最新的。`version` 照旧置空，理由与原来一致：接下来的写用的是新名字，服务器对新文件没有 ETag，`If-Match` 会拒绝（0035 改名时定的）。

### 三、回归测试

`tests/engine.spec.ts` 的 `describe('a backup deleted on the server')` 用一条测试钉住第一条：先同步一次让服务器有文件、本地缓存留下同一份字节，再删掉服务器上的文件，第二次同步必须 `pushed: true` 且文件回到服务器上（`here`/`there` 都为空 —— 不是「谁改了谁」，而是「服务器空了，重新上传」）。

## 影响

- `src/engine.ts`：`openRemote` 去掉 `cached()` 兜底，`data` 为空直接返回 `empty`；`cached` 这个辅助函数本身保留，仍由「未修改」的合并路径使用。
- `src/dav.ts`：`RateLimitedError.after` 补「毫秒」注释（0076 里已记），`dav.get()` 读旧名改用空条件头与 `notModified: false`。
- 两处「同步说已是最新、备份其实不在了」的场景都变成重新上传；用户在服务器上手动清理备份之后，下一次同步会把它传回去（这与「服务器上留一个加密文件」的整体设计一致 —— 0004）。
- 仍然存在、这次没动的：本机**主动**想删服务器上的备份，走的不是这条路径（手动备份的导出/导入与转发面板各有自己的删除语义，0046/0054/0070），不受影响。
