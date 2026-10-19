# 0035 备份文件改叫 `.prop`，旧名只读回看

- 状态：已接受
- 日期：2026-10-19

## 背景

用户 2026-10-19 的需求（原话：「将文件后缀改为 .prop」）。服务器上的备份文件原本叫 `dsh-profile.dshsync`。`.dshsync` 是插件早期的名字（包名 `dsh-webdav-sync`），而这个文件里装的其实是**整个 setup 的一份封好的配置档**，`.prop` 更贴近它是什么。

改名的棘手之处不在改字符串，而在**已经同步过的机器**：它们的服务器文件夹里躺着 `dsh-profile.dshsync`。如果代码只按新名字找，读取会得到「服务器上没有我们的文件」——在 [0024](0024-adopting-server-keeps-local.md) 的语义里那是「本机首次加入」，于是这台电脑会把自己的配置推上去，**静默盖掉另一台电脑留在服务器上的那份**。这正是 [0007](0007-never-silently-overwrite.md) 立规矩要避免的情形：宁可说清楚，也不静默覆盖。

`.dshsync` 出现在三处派生位置，都是常量推导出来的，不需要逐个改：

```ts
export const REMOTE_FILE = 'dsh-profile.prop'
export const BACKUP_EXT = '.prop'
// 派生物，跟着上面两个走：
//   src/state.ts   CACHE_NAME       = `sync-server${BACKUP_EXT}`        → sync-server.prop
//   src/store.ts   留档名           `sync/<时间戳>-before-apply.prop` 等
```

## 决策

**只读回看旧名字，不回写、不删除**。`src/wire.ts` 新增一个只用于读取的常量：

```ts
export const LEGACY_REMOTE_FILE = 'dsh-profile.dshsync'
```

`Dav.get()` 找不到 `REMOTE_FILE` 时再读一次旧名字（`get()` 内部拆出 `readAt(url, headers, have)`，两处地址共用同一段 304/403/404/409/410 判断）：

```ts
const read = await this.readAt(this.fileUrl, headers, have)
if (read !== undefined) return read
const legacy = await this.readAt(this.url(REMOTE_FOLDER, LEGACY_REMOTE_FILE), headers, have)
return legacy === undefined ? { version: {} } : { ...legacy, version: {} }
```

于是升级后的第一次同步是**一次普通同步**：读到旧文件、与本地三方合并、正常写新名字。服务器不会出现「空 → 覆盖」那一步。

**旧文件带来的版本号被丢弃**（`{ ...legacy, version: {} }`）。这是必须的：读到的 ETag 属于旧名字，而接下来的写是对**新名字**的 `PUT`，服务器对那个地址没有文件，`If-Match` 一个不存在的文件的 ETag 只会得到 412。丢掉版本号等于把这一次写成「无条件写新文件」，但内容是刚刚**合并过**的字节，不是盲写（盲写的风险与护栏见 [0017](0017-blind-write-baseline-guard.md)、[0024](0024-adopting-server-keeps-local.md)）。代价是这一次写没有服务器侧的乐观并发校验，窗口仅限首次迁移那一次。

**`stat()` 也看旧名字**，只在新名字确实没有时才多发一次 PROPFIND：卡片的「检查」按钮问的是「服务器上有没有我们的备份」，旧名字里那份也算。

**服务端不做改名或清理**。没有 `MOVE`、没有 `DELETE`：迁移发生在下一次真的需要写的时候（内容没变就不写），旧文件留在原地等用户自己删。理由是没有一个「安全的时机」可言——刚启动时不能写、读的时候不能顺手写、多台机器会各跑一遍。

被否决的备选：

- **改名后旧名照旧写**（两个名字都写）。每台机器每次同步两个 PUT，冲突面翻倍；且两份副本迟早会不一致，那时「哪份算数」又没有规则。
- **读取时顺手 `MOVE`**。`get()` 是只读语义，混进一次写操作会破坏「打开卡片、看一眼状态」这类路径的只读性；而 MOVE 本身也不是所有 WebDAV 实现都支持，失败还得降级——降级路径与上面直接兼容读回看完全等价，不如只留一条。
- **不兼容，要求用户手动改名**。对「另一台电脑还在用旧版本」的用户是静默覆盖，与 0007 直接冲突。
- **保留 `.dshsync` 作为 `BACKUP_EXT`，只改 `REMOTE_FILE`**。派生出来的留档名与缓存名会各带一个后缀，读起来更乱；用户要的是后缀。

## 影响

正面：

- 升级后的第一次同步不丢任何一边的配置，用户感知为「一切照旧」。
- 旧名字只影响读取路径，写路径永远用新名字，不会出现两个活跃副本。
- `CACHE_NAME`、留档名、测试常量都由常量派生，改一处即全部跟上；旧缓存（`sync-server.dshsync`）因为文件名不匹配自然不再被读，留着也无害。

负面：

- **旧文件不会被自动清掉**：文件夹里会同时有 `.dshsync`（不再更新）与 `.prop`（活跃）两份，直到用户手动删除。README 与本文都写明了这一点。
- **迁移写那一次没有 `If-Match` 保护**，两台机器同时做首次迁移时有窗口（内容来自各自的合并结果，最坏结果是后写者覆盖前者，与无 ETag 服务器上的情形同类）。
- 内容没变的一次普通同步不会触发迁移：`notModified` 早退时不写服务器，所以 `.prop` 可能一直不出现。要立刻完成迁移，点一次「立即同步」（强制）。
- 读取多了一次 `GET`（仅在新名字不存在时），`stat()` 可能多一次 `PROPFIND`。
- 已经装在机器上的旧版本不会消失：它仍按旧名字读，能读到新写的 `.prop` 吗？不能——旧代码只认 `.dshsync`，于是它会把服务器看成空的。**跨版本共存仍不安全**，这一点只能靠「都升级」解决。

## 相关

- `src/wire.ts` —— `REMOTE_FILE`、`BACKUP_EXT`、`LEGACY_REMOTE_FILE`。
- `src/dav.ts` —— `get()` / `readAt()` 的旧名回看、`stat()` 探测。
- `src/state.ts` —— `CACHE_NAME` 随 `BACKUP_EXT` 派生。
- `tests/dav.spec.ts` —— 「reads a backup left under the name it had before the suffix changed」。
- `docs/decisions/0024-adopting-server-keeps-local.md`、[0007](0007-never-silently-overwrite.md) —— 「服务器看起来是空的」为什么危险。
