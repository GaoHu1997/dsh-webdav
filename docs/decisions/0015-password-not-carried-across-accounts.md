# 0015 — 改地址或换账号时，不许把已存的密码带过去

- 状态：已接受
- 日期：2026-10-16（全面检测阶段发现并修复）

## 背景

`ConfigureBody` 的约定是「**空的 secret 字段表示沿用已存的那个**」。这条约定本身是对的，理由写在 `configure()` 的头注释里：卡片只被告知「某个 secret 是否已设置」（`ConfigView` 里的 `passwordSet` / `passphraseSet`），所以它**没有能力**把一个它从未见过的密钥写回去；而一个没有动过密码框的表单提交，不应该把密码抹掉。

问题出在这条约定的**适用范围**上。`configure()` 原本只按字面理解它：

```ts
  const next = { ...engine.config }
  if (typeof body.url === 'string') next.url = body.url.trim().replace(/\/+$/, '')
  if (typeof body.user === 'string') next.user = body.user.trim()
  if (typeof body.password === 'string' && body.password !== '') next.password = body.password
```

`next` 是从上一份配置复制的，所以用户只改了地址（或只改了用户名）、没碰密码框时，**旧的密码被原样带到了新的服务器或新的账号上**。

而 `src/state.ts:150-157` 的 `sameAccount` 明确写着相反的意图：

```ts
/**
 * Whether two configurations point at the same account. A password is only ever
 * reused for the server and user it was given for: keeping one across an address
 * change is how a password for one service gets sent to another.
 */
export function sameAccount(a: SyncConfig, b: SyncConfig): boolean {
  return normaliseUrl(a.url) === normaliseUrl(b.url) && a.user.trim() === b.user.trim()
}
```

**这段注释描述的是意图，而不是一道已经落地的闸门。** 在本次改动之前 `grep sameAccount` 的结果是：`src/state.ts` 里定义，`src/engine.ts:65` 与 `:1046` 中转，`src/index.ts:47` 导入、再导出——**运行时路径上一次都没有调用**。它在 `tests/state.spec.ts:106-115` 有测试，测的是它自己算得对不对，不是「有没有人用它」。（那句再导出现在是 `src/index.ts:379`，因为本次改动在 `configure()` 里加了行。）

具体后果：用户在卡片里把地址从 A 服务改成 B 服务，点保存。`saveConfig` 把 `{url: B, password: A的密码}` 写进 `sync.json`。之后每一次同步（包括**自动同步的定时器**，它不需要任何人为动作）都会带着 A 的密码向 B 发 HTTP Basic 认证头。往一个不相关的服务发送另一个服务的凭据，是凭据泄漏，不是不方便——即使 B 拒绝它，泄漏也已经发生。

这正是 ADR [0011](0011-state-key-isolation.md) 的「负面」一节当时就记下来、但没有修的那一条：*「`sameAccount` 在本仓库里只被导出……并没有拿它来强制清空密码；密码要等到下次手动保存配置时才会被重新考虑。这一点在 ADR 里明确记下来，因为代码注释描述的是意图而非一道已经落地的闸门。」* 这条 ADR 就是那道闸门。

## 决策

**在 `configure()` 里调用 `sameAccount`：账号变了，且这次提交没有给出新密码，就把沿用下来的那个丢掉。**

```ts
  const next = { ...engine.config }
  const gavePassword = typeof body.password === 'string' && body.password !== ''
  if (typeof body.url === 'string') next.url = body.url.trim().replace(/\/+$/, '')
  if (typeof body.user === 'string') next.user = body.user.trim()
  if (gavePassword) next.password = body.password as string
  ...
  // A blank password field means "keep the stored one", which is only a faithful
  // reading while the stored one belongs to the same account. Pointing this
  // computer at another server or user while carrying the old password along
  // would send a credential for one service to another, so the carried-over one
  // is dropped rather than reused. A password typed in this same submit is kept:
  // it was given for the address being saved.
  if (!gavePassword && !sameAccount(engine.config, next)) next.password = ''
  if (!next.rememberPassword) next.password = ''
```

**要点一：先记下「这次提交到底给没给密码」（`gavePassword`），再判断账号。** 这条最容易被写错：如果只写 `if (!sameAccount(...)) next.password = ''`，那么**用户在同一张表单里同时改地址并填新密码**时，那个刚填的新密码会被立刻丢掉——用户看到保存成功，密码却没了，下次同步 401。`gavePassword` 把「沿用的」与「这次给的」区分开：只有前者会因账号变化被丢。这也是 `tests/index.spec.ts` 里那条 `keeps a password typed in the same submit that changes the address` 存在的原因。

**要点二：比较的是规范化后的地址。** `sameAccount` 内部走 `normaliseUrl`，所以只在末尾斜杠或首尾空白上有差异的地址（`https://dav.test/dav` → `https://dav.test/dav/`）**不算**换账号，密码保留。用户重新粘贴一遍同一个地址不会莫名其妙要重填密码。

**要点三：这不改变「空口令 = 沿用」的语义。** 口令（`passphrase`）不进 `sameAccount`，改地址时它照旧保留。理由与 [0011](0011-state-key-isolation.md) 一致：口令只在本机用于解密，从来不会被发给任何服务器，所以没有「被发到别的服务」这条风险路径。**只有会被发送出去的密码需要这道闸门。**

**被否决的备选：**

1. **在卡片（浏览器半边）里判断并清空密码框。** 卡片拿不到已存的密码，也不知道上次保存的地址是什么（`ConfigView` 里只有当前值），所以它无法判断「这次改的地址算不算换账号」。而且这会是一条能被绕过的规则——真正在写文件的是 Host。
2. **改地址时连口令一起清空，彻底当作新同步。** 与 [0011](0011-state-key-isolation.md) 的 `turnOff` 保留状态是同一个思路的放大版，但过度：口令不会外发，清掉它只让用户多做一次输入，且会连带作废一条本来还有效的基线。
3. **保存时直接报错，要求用户自己清掉密码框。** 卡片没有办法清一个它没见过的字段（这正是「空 = 沿用」存在的理由），所以这条要求用户做不到。静默丢弃并在界面上体现（`passwordSet` 变 false）是唯一能落地的行为。
4. **在 `dav.ts` 发请求前按 host 校验密码来源，发不出去。** 更靠底层，但 `Dav` 每次都是新建的、不持有历史配置，判定不了「这个密码是为哪个 host 设的」。判断只能在保存的那一刻做。

## 影响

正面：

- 改地址或换账号之后，旧密码不会被发送到新的服务器或账号上——自动同步的定时器也不再有这条路径。
- `sameAccount` 从「被导出但没人用的意图」变成真正生效的规则，它的注释与代码一致了。
- 用户在同一张表单里改地址并填新密码时，新密码被正确保留。
- 只在末尾斜杠上有差异的地址重新粘贴不会触发清空。

负面：

- **用户在卡片上只改地址、保存，会看到密码「已设置」的标记消失**，需要重新填一次。这是刻意的（`passwordSet` 现在报的是真实情况），但界面上没有一句话解释为什么——只能靠用户自己意识到地址变了。要改得更好需要往 `ConfigureBody`/`ConfigView` 里加「密码因账号变化被清空」的提示字段，本次没有做。
- `configure()` 现在有 4 条相互作用的规则（`gavePassword` / 账号变化 / `rememberPassword` / 口令≠密码），顺序不能换：把 `if (!next.rememberPassword)` 挪到账号判断之前，`gavePassword` 的值仍然正确，但两条 `next.password = ''` 的语义会混在一起，读起来更难。
- `configure()` 此前**完全没有测试**（`grep configure tests/` 在本次改动前只命中两处无关的 `configured`）。本次新增的 `tests/index.spec.ts` 是第一个直接测它的套件——也就是说这条规则在此之前从来没有被任何测试保护过。

## 验证

- 新增 `tests/index.spec.ts`，10 例，覆盖：空白字段沿用密码、表单给出密码则采用、改地址丢沿用密码、换账号丢沿用密码、**同一次提交里改地址并给新密码则保留新密码**、只差尾斜杠的地址不算换账号、`rememberPassword: false` 清空、口令等于密码被拒、空白口令沿用、`autoEvery` 非法值被忽略。
- 全量 `pnpm test`：**156 → 166 例**（6 个文件，新增 `tests/index.spec.ts` 10 例），全通过。
- `pnpm run typecheck` exit 0；`pnpm run build:all` exit 0。
- 打包产物端到端（`.pkgcheck/pkg-e2e.mjs`，加载 `lib/index.js`、经真实 HTTP host、对真实 WsgiDAV 服务器）：**27 → 33 项断言全过**，新增 6 项走的是真实 `/config` 路由 —— 给第一个服务器设密码后 `/status` 报 `passwordSet: true`；改地址后 `/status` 报 `passwordSet: false` 且 `url` 是新地址；磁盘上的 `sync.json` 里 `password` 确实为空；随后带着新地址提交一个新密码，`/status` 又报 `passwordSet: true`。这 6 项放在脚本末尾，因为它刻意把配置留在改动后的状态。

参考 [0011](0011-state-key-isolation.md)（`stateKey`/`sameAccount` 的语义与它当时记下的这个缺口）。
