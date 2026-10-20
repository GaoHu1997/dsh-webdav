# 0054 — 新增第六份「API 密钥」，让同步过去的那份配置真的能用

- 状态：`已接受`
- 日期：2026-10-21
- 接续：[0005](0005-four-parts-and-plugin-exception.md) 的四份、[0036](0036-extra-directories-part.md) 的第五份；这一份是第六份，也是唯一一份内容是秘密的分片

## 背景

用户 2026-10-21 的原话：「api密钥没有同步」。

不是漏了某个字段，是**这个插件的分片边界画在了密钥的左边**。DSH 的 profile 里从来不存密钥，只存密钥的**名字**：

- `llm-pi-ai` 的 provider 路由上是 `apiKeyEnv: OFOX_API_KEY`（`node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js:1014`，`apiKeyEnv: z.string().role("credential-ref")`），`webhook-github` 上是 `secretEnv`。
- 真值在 DSH 的凭据服务里。`resolveApiKey` 的写法是 `const ref = profile.apiKeyEnv; const credentials = ctx.get("credentials"); const hit = credentials !== void 0 ? (await credentials.resolve(ref))?.value : launchEnvironmentOf(ctx).get(ref)?.value`（同一文件 `:2574-2579`），解析不到就抛 `MISSING_CREDENTIAL`，消息是 `llm-pi-ai: no credential for provider route "…"; its profile resolves …`。
- 服务的分层由 `@deepseek-ai/dsh-credentials-local` 决定，从高到低：继承来的进程环境（只读，赢）> `$DSH_HOME/.credentials.yaml`（可写，`refs:` 一节）> 项目 `.env` > `$DSH_HOME/.env`。`set(ref, value)` 只写中间那一层；被只读层遮住时它会拒绝。

于是「同步完成」与「另一台电脑能用」之间隔着一整个凭据存储：`models` 那一份把 `apiKeyEnv: OFOX_API_KEY` 原样带过去了，另一台电脑上这个名字解析到空，每个 provider 都报 `MISSING_CREDENTIAL`。用户看到的是配置同步成功、模型全不可用。

约束有三条，都来自凭据服务本身：

1. **服务不能枚举引用名**。`CredentialProvider` 只有 `resolve` / `describe` / `set` / `unset`，`listRecords` 覆盖的是 OAuth 的 `records` 那一半；`dsh-credentials/lib/types/index.d.ts:166-174` 明说引用这一半没有枚举接口，界面上的名字是从各自的 schema 学来的。所以本插件没法「把本机所有密钥都发出去」。
2. **只读层会赢**。一个既导出又存了的名字，`resolve().source` 是 `'env'`，此时 `set` 会拒绝。把它当失败报出来会天天报警；把它当成功写下去是撒谎。
3. **`set` 不接受空值**（`credentials-local: an empty value cannot be stored for "…"; use unset`），而「删除」在跨机同步里本来就没有安全的语义。

## 决策

### 一、加第六份 `keys`，内容是一张「名字 → 值」的表

`PARTS` 末尾追加 `'keys'`（`src/wire.ts:85`），`Bundle` 得到 `keys?: { refs: Record<string, string> }`（`src/wire.ts:232-257`）。名字就是地址，所以这一份是 map 而不是列表；值只有字符串。

排在最后是因为合并顺序按 `PARTS` 走，前五份的行为一个字节都不动。

### 二、名字从**配置**里读，不从存储里读

`credentialRefs(parts)`（`src/keys.ts:101-121`）递归走一遍即将发出的那几份，凡遇到 `CREDENTIAL_FIELDS`（`['apiKeyEnv', 'secretEnv']`，取自 `llm-pi-ai` / `llm-deepseek-api-key` / `web-search-deepseek` / `webhook-github` 四个 schema）且值是非空字符串，就记下这个名字。

为什么不是从存储里列举：服务没有枚举接口（背景第 1 条）。为什么这个方向反而是对的：**密钥跟着点它名的那一份走**——`models` 不发，里面的 provider 名字也就不发，密钥自然不发，不需要第二套「哪些该发」的判断。字段名集中成一个常量，将来 DSH 再添一个引用字段只改这一行。

### 三、只有托管存储里的值才走，环境导出的不走

`readKeys`（`src/keys.ts:142-161`）逐个 `resolve`，只有 `source === 'file'` 才收进这一份。理由两条，方向一致：托管存储是本插件唯一能写回的那一层；而环境导出属于「谁启动了 DSH」，不属于这台电脑存的配置——把它抄到另一台电脑的存储里，等于替那台机器做了一个它没做过的决定。

副作用是：一个既导出又存了的名字，本机读到的是导出值，于是不发。想让存储里的值成为生效值并发出去，办法是在 shell 里 unset 它——这正是服务自己「环境赢」规则的意思。

解析不到值的名字**跳过**，不报错：很多 profile 点了一个没人登录过的 provider，「这个键也不在」不是同步失败。解析**本身**失败才报（`KeyProblem`）——读不了的存储不能长得像空存储，否则一次同步会把它读成「这台电脑没有密钥」然后什么也不发。

### 四、写入跳过已在生效的值，且先留档

`applyKeys`（`src/keys.ts:180-206`）对每个名字先 `resolve`，值相同就跳过。这不是优化：被只读层遮住时 `set` 会拒绝，而一个已经在生效的值（同一个键，导出并存储）再写一次会被报成失败，等于因为「说了第二遍」而报警。

`beforeWrite` 回调最多调用一次，就在第一个真正覆盖旧值的写入之前——引擎借它把本机现状封进 `sync/before-apply`（`src/engine.ts:811`），撤销才有东西可放回。凭据没有文件、没有 mtime，所以这一份必须显式留档。

### 五、永不删除

`applyKeys(null | undefined)` 直接返回，`null`（合并里「这一份被拿掉」的表达）什么也不写。跨机同步里「删除」无法区分「这台机器上删的」与「那台机器上没有」；而且 `set` 本身也拒绝空值。删密钥是人在设置页做的事。

### 六、密钥也有自己的开关，默认开

`SyncConfig.keys`（`src/state.ts:61`）与其余四份并列，`syncsPart` 里 `case 'keys': return config.keys`（`src/state.ts:266-267`）。关掉时既不读也不写，服务器上的那一份原样带过——不是「删掉」。

为什么给开关而不是无条件发：秘密落到别人磁盘上的承诺，和配置落过去不是同一个承诺。一个共用 WebDAV 目录的人应该能说「这些不要过去」。默认开是因为：只发配置不发密钥，正是用户报的那个 bug。

### 七、冲突按「本机赢」，且不按 mtime 比

`localChangedAt(snapshot, 'keys')` 返回 `Number.POSITIVE_INFINITY`（`src/engine.ts:1402`），`preview` 里两边都动过时直接给 `take: 'local'`（`src/engine.ts:1331`）。凭据没有文件也没有修改时间，拿不到一个诚实的「谁更新」；而两边都动过的密钥里，本机这个是本机正在用的，换掉可能当场把模型打断。输的那一份由 `keepConflict` 照常留档。

### 八、宿主拿不到服务就照实说，不假装成功

`credentialPort(ctx)`（`src/index.ts:234-240`）用 `ctx.get('credentials')` 结构化取服务，取不到就是 `undefined`；`readKeys` / `applyKeys` 遇到 `undefined` 各报一条 `ref: ''` 的问题（`这台电脑没有 DSH 的凭据服务，API 密钥不在这里读写`），卡片按 `keyStoreProblem` 显示。

为什么不写进 `inject`：没有凭据服务的宿主是**可用状态**（其余五份照常同步），把它变成硬依赖等于让插件在那种宿主上装不上。`ctx.get` 在 cordis 4.0.4 上就是「不声明依赖地读一个服务」（`lib/types/reflect.d.ts:14-16`）。

### 九、`dsh-credentials` 不进依赖

`CredentialService` 与 `KeysPort` 是本仓库自己写的结构类型（`src/keys.ts:61-70`），只用到 `resolve` / `set` 两个方法。加一个 peer 依赖去拿两个方法的类型，换来的是每个宿主都得装那个包、以及跟着它的版本走。

## 影响

- **正面**：用户报的那个 bug 修掉了——同步过去的那份配置在另一台电脑上真的能连上 provider。密钥与点它名的分片同生同灭，不存在「配置发了、密钥忘了」的中间态。
- **正面**：密钥有自己的开关，共用服务器的人可以把它关掉，关掉不等于删除。
- **正面**：读不成、写不成都会出现在卡片上（`keyProblem` / `keyStoreProblem`），而不是安静地少发一份。
- **负面**：秘密现在会离开本机。文件在离开前用口令封（[0002](0002-passphrase-sealed-backup.md)），服务器上只有密文；但口令本身若与 WebDAV 密码相同会被 `configure` 拒绝（既有的那条检查），这条规则现在更重要了。
- **负面**：`CREDENTIAL_FIELDS` 是一张手抄的表。DSH 之外的插件用别的方式命名凭据字段，它的密钥不跟着走，而且不会有任何提示。
- **负面**：环境导出的键不发，可能让「我明明有 key」的人困惑一次。卡片上不会解释这一点（没有稳定的地方说），这是这次留下的粗糙处。
- **负面**：`keys` 让 `Bundle`、`PartHashes`、`SyncConfig`、`ConfigView`、`ConfigureBody`、`StatusResult`、`SyncResult` 各多一个字段，浏览器半边与宿主半边的 wire 约定同步变宽。
- **验证**：新增 `tests/keys.spec.ts`（26 条），覆盖 `credentialRefs` 的递归与去重、`readKeys` 的「跳过 vs 报错」、`applyKeys` 的「值相同不写」「被遮住报出来继续下一个」「任何读法都不删」，以及四条真同步：本机 → 服务器、服务器 → 本机、写不进去时报在结果上、关掉时一个字节都不读不写。`tests/state.spec.ts` 补了旧配置（没有 `keys` 字段）读成 `true` 的那一条。`pnpm typecheck`、`pnpm build`、`pnpm test`（14 个文件 406 条）全绿。
