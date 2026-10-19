# 0011 — 状态以 `stateKey` 隔离，`errorKey` 记录失败所针对的配置

- 状态：已接受
- 日期：2026-10-16（本仓库首次提交）

## 背景

三方合并需要一份**基线**：上一次同步结束时，本机四份分别是什么哈希，服务器四份分别是什么哈希。这份基线存在 `<profileDir>/.dsh-webdav-sync/sync-state.json` 里。

问题在于，这个文件是**跟着 profile 目录走的**，而配置（`sync.json`）是可以改的：

- 用户把地址从 A 服务器改到 B 服务器；
- 用户在同一台服务器上换了个账号；
- 用户换了加密口令（或者发现自己一直打错，改成了对的）。

这三种改动都会让基线**描述另一个文件**。此时如果继续拿旧基线去合并，会发生最坏的一类错误：

假设用户之前同步到 A 地址，基线里记着 `models` 的哈希是 X。现在他把地址改成 B——B 上恰好有一个不相关的 `dsh-profile.dshsync`，或者 B 是同一个文件夹但里面是一个月前的旧版本。旧基线说「上次服务器上是 X」，而新服务器上是 Y。合并逻辑会认为「服务器侧改了」（Y ≠ X），于是**把 B 上的旧内容当成新内容拉下来覆盖本机**。用户看到的现象是：改了个地址，配置被倒退回一个月前。

反过来也危险：如果 B 是空的，而基线仍然有效，代码会以为「服务器上有过东西、现在没了」，从而走删除路径。

还有一个更隐蔽的问题在**错误记录**上。`state.error` 存的是最近一次失败的文案，卡片把它显示出来。但如果这次失败是**口令打错**造成的，那么这次失败本身就改变了配置（用户会在卡片里改口令再试）——而修改后的配置对应一个新的 key，基线因此为空，`status()` 里那个「这条错误适用于当前配置吗」的判断就不再成立，错误会消失。也就是说：**最需要被看见的那类失败（口令不对）恰好是最容易被判为「不适用」而消失的。**

## 决策

**基线由 `stateKey` 隔离。** `src/state.ts:144-148`：

```ts
export function stateKey(config: SyncConfig): string {
  return createHash('sha256')
    .update([config.url.trim().replace(/\/+$/, ''), '\u0000', config.user, '\u0000', config.passphrase].join(''))
    .digest('hex')
}
```

key 由三样东西构成：**规范化后的地址**（去掉首尾空白与末尾斜杠）、**用户名**、**口令**。注释写明了意图：

```
 * Identifies the thing a state describes: one server, one account, one
 * passphrase. A change to any of them resets the state, because the hashes in it
 * are about a file that is no longer the one being synced.
```

**读状态时校验，不匹配就当作空的基线**（`freshState`，`src/engine.ts:152-161`）：

```ts
  const state = await loadState(paths)
  const key = stateKey(config)
  if (state.key !== key) {
    // Another folder, account or passphrase: the hashes describe a file that is
    // no longer the one being synced, so they are no baseline for anything.
    return { key }
  }
  return state
```

注意返回的是 `{ key }`——保留了新 key，**但丢掉全部哈希**（`local`/`remote`/`sum`/`server`/`undo`/`notice`/`last` 都没了）。下一次同步因此走的是「首次同步」路径：本机的四份被当作第一版推上去，服务器上的东西不会被当成「新内容」拉下来。

**口令刻意进 key**，虽然它已经在 `sync.json` 里、不进浏览器。理由：换了口令之后**服务器上的文件已经换了密文**，即便地址和账号没变，那份文件的哈希/内容与基线描述的也不是同一个对象了；而且换口令通常伴随「我在另一台机器上重建了备份」，此时把旧基线当有效会更危险。

**但口令带来的这个副作用要用 `errorKey` 补回来。** 失败被记录时，同时记下「失败时用的是哪个配置」（`recordFailure`，`src/engine.ts:163-178`）：

```ts
    state.error = message(cause)
    // The failure is recorded against the configuration that failed, not against
    // whichever one was synced last. A wrong passphrase changes the state key and
    // so would never match the stored one — and a failed sync that left no trace
    // is the one kind of failure a person cannot act on. The baseline hashes are
    // left exactly as they are: this run learned nothing about the server.
    state.errorKey = stateKey(engine.config)
```

三件事同时被保证：

1. `state.error` 记录下来；
2. `state.errorKey` 是**失败那一刻的配置**的 key，不是上次成功同步的那个；
3. **基线哈希原封不动**——这次运行没有从服务器学到任何东西，不该拿它当依据。

于是 `status()` 里（`src/engine.ts:842`）：

```ts
  const errorApplies = fresh || (state.errorKey !== undefined && state.errorKey === stateKey(config))
```

`fresh` 覆盖常规情况；`errorKey` 覆盖「失败本身改变了 key」的情况。用户打错口令 → 失败 → 卡片上现在显示的是**打错的这个口令**对应的配置，`errorKey` 与之一致，所以错误照样显示出来。用户改对了口令 → key 又变 → `errorKey` 不再匹配，错误消失，符合直觉。

**同一原则贯穿全文件**：所有从状态里读出来的东西都要先过 `fresh` / `state.key === stateKey(config)` 这一关。

| 位置 | 判断 | 不匹配时的行为 |
| --- | --- | --- |
| `freshState` | `state.key !== key` | 返回空基线（只留新 key） |
| `status` 的 `last` | `fresh && state.last` | 不显示「上次同步」时间 |
| `status` 的 `notice` | `fresh && state.notice` | 不显示上次同步的通知 |
| `status` 的 `undoable` | `fresh && state.undo` 非空 | 「撤销恢复」不可用 |
| `undo` | `state.key !== stateKey(config)` | 抛 'there is no restore to undo' |
| `dismiss` | `state.key !== stateKey(config)` | 静默返回，不清通知 |

**一个刻意的例外：`turnOff` 保留状态。** `src/engine.ts:877-880`：

```ts
/**
 * Turn sync off, keeping what is known about the server.
 *
 * The state is kept deliberately: turning sync back on to the same address must
 * not read as joining a folder for the first time, which would take the server's
 * older setup over this computer's newer one.
 */
export async function turnOff(engine: Engine): Promise<void> {
  const config = { ...engine.config, url: '', password: '' }
```

「关闭同步」只清 `url` 与 `password`，`sync-state.json` 原样留着。重新填回同样的地址、账号、口令时，`stateKey` 又变回原来的值，基线**自动重新生效**——这正是「我不要同步了，过一小时再打开」应该有的行为，而不是把本机配置当成新版本推上去。

**另外，账号比对是独立于 key 的一层：`sameAccount`。** `src/state.ts:155-157`：

```ts
export function sameAccount(a: SyncConfig, b: SyncConfig): boolean {
  return normaliseUrl(a.url) === normaliseUrl(b.url) && a.user.trim() === b.user.trim()
}
```

它**故意不看口令**，注释解释了为什么：

```
 * A password is only ever reused for the server and user it was given for: keeping
 * one across an address change is how a password for one service gets sent to
 * another.
```

也就是「密码」的复用范围比基线更窄：换地址或换账号就必须重填密码，因为把 A 服务的密码发给 B 服务是一个凭据泄漏，而不是一次不方便。

**还有一层针对「无条件写入」的补丁：`blind`。** 如果上次写服务器时没拿到 ETag（`dav.put` 在某些服务端行为下拿不到，见 `src/dav.ts`），那次写入就没有版本条件——它可能和另一台电脑的写入重叠了，而**哪一份落地无从得知**。此时把写之前的哈希存进 `state.blind`，下一次读到「服务器上确实有变化」时先回滚（`src/engine.ts:208-216`）：

```ts
  // A write that went out without the server checking its version may have
  // overlapped another computer's, and which of the two landed cannot be told
  // from here. The state is rolled back to what it was before that write, so the
  // file on the server is merged against rather than mistaken for one already
  // seen.
  if (state.blind !== undefined && read.notModified !== true) {
    state.remote = state.blind.remote
    state.local = state.blind.local
  }
```

## 影响

正面：

- 换服务器、换账号、换口令都不会把旧基线误用到新对象上，也就不会出现「改个地址，配置被倒退回旧版本」这类灾难。
- 错误消息在最需要它的时候不会消失（口令打错的那一刻卡片仍然显示它）。
- `state.errorKey` 与基线哈希的分离让「记录失败」成为纯追加动作，不会污染下次合并的依据。
- `turnOff` 保留状态让「临时关掉」成为一个可逆、无副作用的动作。
- `sameAccount` 把凭据的复用范围收紧到「同一服务器 + 同一账号」，与基线的范围分开考虑。

负面：

- **口令进 key 意味着改口令会丢掉全部基线**。用户只是想「换一个更强的口令」，代价是下一次同步变成一次首次同步：本机四份被重新推上去（服务器上那份旧密文被覆盖），`last`/`notice`/`undo` 都清空。功能上安全（本机内容成为基准），但「上次同步时间」这类信息会消失，且如果本机恰好是较旧的一份，它会覆盖服务器上较新的一份——**换口令时没有任何提示说这件事**。
- **`stateKey` 存的是口令的 sha256**（`sync-state.json`，0600）。它不泄露口令本身，但它是一个**确认口令是否正确的离线校验值**：拿到这个文件的人可以暴力试口令并比对 key，而不需要连服务器、也不需要目标文件。这与「GCM tag 校验」相比把攻击成本从「一次 PBKDF2 + 一次 HTTP」降到了「一次 PBKDF2」——600000 轮 PBKDF2-SHA256 仍然是主要成本，但确实是多出来的一个泄漏面。
- **`errorKey` 只保留一个**。用户连续用两个不同的错口令各试一次，第二条覆盖第一条；卡片只能显示最近的那条。
- **地址规范化只是去空白与末尾斜杠**（`normaliseUrl`），不做大小写归一、不解析 `..`、不处理 `http`/`https` 差异、不理会默认端口。`https://dav.example.com/dav` 与 `https://DAV.example.com:443/dav` 会被当成两个不同的服务器，各有一份基线，且 `sameAccount` 也认为账号变了（于是要求重填密码）。这是「保守到会误判为不同」的一侧，没有反方向的风险，但会让用户困惑。
- 「同一账号」的判定不看密码，所以「换了服务器上的密码」之后 `sameAccount` 仍然成立，旧密码会被继续发出去——此时唯一挡住它的是服务器返回 401。
- 本条 ADR 写下时，`sameAccount` 只被导出、被 `index.ts` 再导出（供组合层使用），`configure()` 并没有调用它，也就是说那句注释描述的是**意图而非一道已经落地的闸门**：改地址时旧密码会被一起带过去。这一点当时就记在这里了，后来由 [0015](0015-password-not-carried-across-accounts.md) 补上了强制。
