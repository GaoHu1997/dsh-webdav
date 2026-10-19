# 0034 额外请求头：一行一条，写在每个请求自带的头之下

- 状态：已接受
- 日期：2026-10-19

## 背景

用户 2026-10-19 的需求（原话：「webdav 增加一个请求头配置功能」）。这个缺口在真实部署里是挡路的：

- 前面套一层反向代理或网关的，常要求带 `X-Auth-Token`、`CF-Access-Client-Id` / `CF-Access-Client-Secret`、租户头之类的自定义头，否则一律 403。
- 只发令牌的服务（Bearer）根本无法用「用户名 + 密码」表达：本插件只会拼 Basic 认证。
- 也有的服务器认 `Depth`、`X-OC-Mtime` 这类头，用来改默认行为。

出网请求只有一个出口：`src/dav.ts` 的私有 `send(method, url, body, headers)`，`GET`/`PUT`/`HEAD`/`PROPFIND`/`MKCOL` 全都经过它。所以「配置头」的落点只有一处，不需要动任何调用方。

## 决策

**配置项是字符串，不是键值对**。`SyncConfig.headers: string`（`ConfigView.headers` 明文下发、`ConfigureBody.headers?` 可选），在卡片上是一个 textarea：

```
Authorization: Bearer xxxxx
X-Auth-Token: abc
```

每行一条 `名字: 值`，空行与 `#` 开头的行忽略。选文本而不是 `Record<string, string>`，是因为配置最终落在 `cordis.patch.yml` 里：多行字符串在那里可读、可手改，而嵌套对象要被 YAML 序列化成好几层，用户手写时容易写坏；也避免了「键名带冒号/空格」这类在对象里没法表达的输入。

**解析是严格的，坏行带着行号报错**。`parseHeaders(text)` 在 `src/dav.ts` 导出：

```ts
if (at < 1 || !/^[\w!#$%&'*+\-.^`|~]+$/i.test(name)) {
  throw new Error(`第 ${index + 1} 行「${line}」不是请求头：请写成「名字: 值」，一行一个`)
}
```

保存时（`src/index.ts` 的 `configure()`）先解析一遍，坏行在**保存那一刻**就说清楚是第几行；坏行不被静默丢弃，否则一个笔误要等到下次同步失败才被发现，而且那时只会说「HTTP 403」。

**合并顺序：配置头先写，每个请求自带的头后写**，因此同名时以请求自带的为准：

```ts
const merged = new Headers()
for (const [name, value] of Object.entries(this.extraHeaders)) merged.set(name, value)
for (const [name, value] of Object.entries(headers)) merged.set(name, value)
```

这不是随便定的。请求自带的头里有一批是**正确性依赖**的：`if-match` / `if-none-match`（[0017](0017-blind-write-baseline-guard.md) 的乐观并发）、`depth`（PROPFIND 只问一层）、`accept-encoding: identity`（[0004](0004-single-remote-file.md) 之前那条「压缩会改写 ETag」的理由）、`content-type`。若让配置头覆盖它们，用户填一个 `Depth: infinity` 就能把一次「问目录在不在」变成遍历整棵树；填一个 `If-None-Match: *` 就能让写入永远被拒。配置头是**补充**，不是接管。

**`authorization` 是唯一的例外**：只在请求自身没有 `authorization` 时才拼 Basic。

```ts
if (!merged.has('authorization') && this.user !== '' && this.password !== '') {
  merged.set('authorization', basic(this.user, this.password))
}
```

这样「用 Bearer 代替 Basic」是可行的——这正是加这个功能最常见的动机之一。反过来说，一旦配置里写了 `authorization`，用户名密码就完全不再参与（服务器只会看到一个 `Authorization`），这点写在 README 里。

**引擎侧收敛成一个助手**。六处 `new Dav({ url, user, password })` 换成 `davOf(config)`：

```ts
function davOf(config: SyncConfig): Dav {
  return new Dav({ url: config.url, user: config.user, password: config.password, headers: parseHeaders(config.headers) })
}
```

理由是「解析一次、每处都解析」比「六个调用点各拼一遍」更难写错；`viewOf` 同时把 `headers` 明文交给卡片（它是配置，不是机密）。

被否决的备选：

- **当机密处理**（像 `passwordSet` 那样只下发布尔、写空即保留）。多行文本无法回显就意味着无法编辑：改一个头得把整段重打一遍，而它本来就不怕看。
- **只允许未知头名，禁止覆盖 `authorization`**（「只补 Basic」）。这会把最需要它的用法（Bearer）堵死；安全边界应由服务器判定，不是本地猜。
- **把 `headers` 并进 `stateKey`**。与 [0026](0026-password-not-in-state-key.md) 同理：它是传输细节，换一个网关令牌不该让「本机上次同步到哪」失效。
- **在每个调用点各自解析**。同一段文本会被解析六次，且「坏行在哪报错」取决于走的是哪条路径。

## 影响

正面：

- 网关、反代、令牌鉴权这三类部署从「完全用不了」变成「填两行就行」。
- 坏行在保存时按行号报出，不会变成一次莫名其妙的 403。
- 请求自带的头仍掌握正确性相关的键，配置头无法破坏条件写与目录探测。

负面：

- **配置里写了 `authorization` 之后用户名密码被忽略**，这是一条只写在 README 里的约定，界面上没有提示。
- 头名匹配用的是 `Headers` 的规则（大小写不敏感、值里的换行已被解析阶段排除），但**重复的头**（同名两次）只保留最后一条：请求头语义里有的头允许多值，这里表达不了。
- `headers` 明文停留在 `sync.json` 与卡片之间，和地址、用户名同一档；README 里明确写了「不要填只有本地才该知道的机密」，但没有任何技术手段阻止。
- 每次 `davOf()` 都解析一遍文本，坏行要到**第一次请求之前**才抛——若配置在运行中被手改成坏值，同步会在发请求前失败而不是保存时。

## 相关

- `src/dav.ts` —— `parseHeaders`、`DavOptions.headers`、`send()` 的合并顺序、`authorization` 例外。
- `src/engine.ts` —— `davOf(config)` 助手与 `viewOf` 的 `headers`。
- `src/index.ts` —— `configure()` 保存前校验。
- `docs/decisions/0026-password-not-in-state-key.md` —— 「传输细节不进 `stateKey`」的先例。
