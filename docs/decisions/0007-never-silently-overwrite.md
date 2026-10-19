# 0007 — 非我方文件与损坏备份：不静默覆盖，重建需本机曾同步过

- 状态：已接受
- 日期：2026-10-16（本仓库首次提交）

## 背景

WebDAV 上的那个路径是**用户自己给的**，用户给错、或者那里本来就有别的东西，都是正常会发生的事：

- 这是别人（或另一个工具）的文件；
- 这是我的另一个口令加密的备份（比如换口令之前留下的）；
- 这是同一个地址下被转录、被同步盘截断、或上传中途断线留下的**半份文件**；
- 这是代理/门户页塞回来的 HTML。

对这些情况的处理方式，只有两种立场：

1. **以本机为准，写上去**。对「用户就是要覆盖」这件事很痛快，但代价是：任何一次地址填错、任何一次口令打错，都会用一个正常工作的文件换掉对面的东西，而且对面往往没有别的副本。
2. **停下来问**。安全，但需要一个替代动作，否则用户会卡在一个只能删服务器文件的提示里。

第 3 种情况（半份文件）比较特殊：它不是「别人的东西」，它就是**我们自己的、坏掉的**备份。此时「停下来问」是没有意义的——用户除了「知道它坏了」之外没有别的选择，而本机还留着上一次读到的好版本。但它也只有在**本机曾经同步过**（有基线可依据）时才谈得上「重建」；一台从没同步过的电脑遇到半份文件，本质上和遇到别人的文件是同一件事。

还有一类容易混进来的东西是**重定向**：地址填成了某个会跳到登录页或跳转到 `/dav/files/xxx` 之外的路径，服务器 302 到一个 HTML 页面上，那份 HTML 一解析就失败。这看起来像「文件坏了」，实际是地址错了，报成「损坏」会把用户引向错误的方向。

## 决策

**分三种情形处理，各自走不同的路；覆盖永远是显式动作。**

### 1. 别的口令封的 → 报错，不写

`openRemote`（`src/engine.ts:436-441`）：

```ts
    if (cause instanceof PassphraseError) {
      throw new Error(
        'the passphrase does not open the file on the server: it was sealed with another one — use the passphrase set on your other computers',
      )
    }
```

口令错与内容被改在密码学上是同一个失败（GCM tag 校验失败），代码**刻意**不区分——区分开等于给攻击者一个预言机。所以消息只说「打不开，换另一台电脑上那个口令」。

### 2. 半份文件 + 本机曾同步过 → 重建，但把残片留下

```ts
    if (cause instanceof CorruptError && state.local !== undefined) {
      await keepAside(keptDir(paths), 'server-damaged', data).catch(() => undefined)
      return { ...empty, hashes: state.remote ?? {}, empty: false, rebuilt: true }
    }
```

三个要点：

- `state.local !== undefined` 就是「本机曾同步过」的判据——本机有基线，知道对面**本来**该有什么，重建有依据。
- 残片被封进 `sync/<stamp>-server-damaged.dshsync`，所以「坏掉的是什么」仍有据可查。
- 返回 `rebuilt: true` 会覆盖后面所有的推送判断（`src/engine.ts:345-346`）：

```ts
  // `rebuilt` overrides both: the file on the server is a fragment.
  const pushNeeded = force || remote.rebuilt === true || !sameHashes(mergedHashes, remote.hashes)
```

去掉这一条会有一个很隐蔽的 bug：重建时使用的哈希是 `state.remote`（本机记录的上次好版本），所以「四份都没变」在哈希比较里成立，同步会认为无话可说而不写。注释把这一点写明白了：*the bytes on the server are a fragment, so the file has to be written again whatever the hashes say.*

### 3. 不是我们的文件 → 停下来，让用户选

```ts
    if (cause instanceof NotBackupError || cause instanceof CorruptError) {
      throw new Error(
        `the file on the server is not a dsh sync backup (${REMOTE_FILE}): use Write over it if it should be replaced with this computer's setup`,
      )
    }
```

消息里直接给出替代动作（卡片上的「本机覆盖服务器」）。**这个动作本身也带护栏**（`upload()`，`src/engine.ts:718-736`）：先试着自己能不能打开——

| 服务器上那份 | `upload` 的反应 |
| --- | --- |
| 能打开 | 拒绝：'the file on the server is a dsh sync backup this computer can open: Sync now merges with it instead, and nothing was written over it' |
| 用另一个口令封的 | 拒绝：'the file on the server was sealed with another passphrase, so it was not written over' |
| 打不开、也不是备份 | 允许，但先把原文件封进 `sync/<stamp>-server-replaced.dshsync` |

也就是说，`upload` 只对「既不是我们的、又不是我们的口令能开的」文件才生效——它是为「地址下面有个别人的东西」准备的工具，不是给「我想用本机覆盖服务器」当快捷键的。后者应该用 `restore` 的反方向，即正常同步。

**重定向单独报错。** `read.redirectedTo !== undefined` 时（`dav.get()` 在重定向落点与请求路径不一致时带出这个字段，`src/dav.ts:195`）：

```ts
      `the address ends somewhere other than the file: the server sent the request on to ${read.redirectedTo}. Give the address of the folder itself`,
```

判断放在解析文件内容**之前**（`src/engine.ts:416`，在 `open()` 之前），否则跳转出来的 HTML 会被读成「文件损坏」，用户就会去点那个危险的覆盖按钮。

### 4. 「不是我们的文件」的判别本身要宽进严出

`looksSealed()`（`src/crypto.ts:65`）只看前 256 字节去空白后是否以 `{"format":"dsh-webdav-sync-backup"` 开头，用来区分「我们的、但坏了」和「根本不是我们的」：

```ts
    // A backup a relay cut short ends in the middle of `data` and fails here, as
    // does a sign-in page a captive portal answered with. Only a body that
    // begins like ours counts as damage.
```

判断这么松是有意的：宁可把「像我们的」判成损坏（可以重建），也不要把「真的是我们的」判成别人的（会被 `upload` 允许覆盖）。

## 影响

正面：

- 地址填错、路径指到别的工具、口令打错这三种常见误操作都不会毁掉对面的数据；错误消息里直接写着下一步该做什么。
- 半份文件可以自愈：网络中断造成的损坏在下次同步时自动重建，不需要用户手删服务器文件。
- 每次「允许破坏」的路径（重建、被显式 Upload 覆盖）都先留档，所以没有不可逆的动作。
- 区分重定向与损坏，避免把「地址错了」误报成「文件坏了」从而诱导用户点覆盖。

负面：

- **一次网络中断之后的重建依赖本机基线**。如果本机恰好也换过口令或换过地址（`stateKey` 变了，基线为空，见 [0011](0011-state-key-isolation.md)），半份文件会被当作「不是我们的备份」，需要用户手动处理。
- 从没同步过的新电脑遇到半份文件时不会重建，而是报「不是 dsh 备份」。这是刻意的（没有基线就不知道对面该有什么），但从用户视角看是「明明是我的文件却说我不能重建」。
- **口令错与文件被篡改无法区分**，只报「换个口令」。如果用户的口令没写错而是文件被人改过，消息会误导他去找口令。
- `looksSealed` 的前缀判断是一个非常弱的证据：一个恰好以那 24 字节开头的文件会被判为「我们的、坏了」，然后在本机有基线时被静默重建覆盖（原字节留档）——路径上安全，但判断本身是启发式的。
