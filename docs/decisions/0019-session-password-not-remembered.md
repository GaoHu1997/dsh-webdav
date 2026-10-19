# 0019 "不记住密码"只管落盘，不管这一次运行

- 状态：已接受
- 日期：2026-10-16

## 背景

卡片上有一个"记住密码"的复选框。不勾它，插件不应该把 WebDAV 密码写到磁盘上——这是用户明确要的。

第一版把这句话执行成了字面意义：配置文件里存空字符串，同时 `engine.config.password` 也换成空串。后果有两个。

一是这个进程再也认证不了：`Authorization: Basic YWxpY2U6`（alice:），服务器要密码就 401，于是自动同步每次都失败，而界面上看不出原因。

二是"口令不能等于 WebDAV 密码"那道防线被绕过了。那道检查当时只读配置里的密码，密码被清空后等于说"没有密码"，于是可以用 WebDAV 密码本身去封装备份——服务器收到了密码，也就等于拿到了打开备份的钥匙。加密在这里等于没加密。

界面上写的却是"用于本次运行，不会保存"。承诺在，实现反了。

## 决策

"不记住"只约束磁盘。密码留在进程内存里，用完即随进程消失。

`src/state.ts` 加了一个按 state 目录索引的进程内登记表：

```ts
export function holdPassword(paths: ResolvedPaths, password: string): void
export function releasePassword(paths: ResolvedPaths): void
export function heldPassword(paths: ResolvedPaths): string | undefined
```

空字符串表示删除登记。`configure()` 的行为分成两条：

- 要记住：照旧把密码写进 `sync.json`，并 `releasePassword()`——磁盘上已经有一份，内存里不必再来一份。
- 不记住：`next.password` 原样留在 `engine.config` 里，但落盘时写 `{ ...next, password: '' }`，并 `holdPassword()`。

每次从磁盘重建引擎（也就是每条 HTTP 路由）之后，`src/index.ts` 的 `engine()` 用 `heldPassword(paths)` 覆盖配置里的空密码。`turnOff()` 调 `releasePassword()`。

口令等值的检查挪到清空之前，而且比的是**这一轮真正会发出去的那个密码**：

```ts
const inHand = gavePassword || sameAccount(engine.config, next)
const sent = inHand ? (next.password !== '' ? next.password : (heldPassword(engine.paths) ?? '')) : ''
if (next.passphrase !== '' && sent !== '' && sameSecret(next.passphrase, sent)) { ... }
```

`inHand` 的意思是"手上确实有这个账号的密码"。换账号时手上没有（旧密码按 ADR 0015 已经清空），那就没有东西可比，也不该拦。

## 影响

正面：不勾"记住密码"也能正常同步和自动同步；加密备份的安全性不再取决于用户有没有勾那个框。进程重启后密码消失，需要重新输入——这是"不记住"的字面意思。

负面：密码在进程内存里停留到 `turnOff()` 或进程结束。ADR 0003 已经接受了这个前提（配置本来就要加载到内存），这里没有引入新的暴露面。内存登记表按 `stateDir` 索引，两个不同 profile 各有一份，互不干扰。

被否决的备选：
- **保持清空，改文案说"不记住密码就不能用"**。诚实但把一个复选框变成了功能开关。
- **每次需要密码时弹窗**。host 半边在后台跑，没法弹窗。
- **把"口令等于密码"的检查改成拿落盘值比**。落盘值在"不记住"时是空的，等于没有检查。

## 相关

- `docs/decisions/0003-secrets-in-state-file.md` —— 密钥只落两处。
- `docs/decisions/0015-password-not-carried-across-accounts.md` —— 换账号时旧密码不得跟着走。
- `docs/decisions/0002-passphrase-sealed-backup.md` —— 口令的作用。
