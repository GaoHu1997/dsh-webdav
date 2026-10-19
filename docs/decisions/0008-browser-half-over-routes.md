# 0008 — 浏览器半边只走 `/plugin/webdav-sync` 路由，口令只以布尔值下发

- 状态：已接受
- 日期：2026-10-16（本仓库首次提交）

## 背景

DSH 插件有**两半**，运行在两个进程里：

- **Host 半边**（`src/index.ts`）：Node 进程，能读能写 profile 目录、能开 TCP 连 WebDAV、能起子进程。
- **浏览器半边**（`src/client/`）：跑在用户的浏览器里，能画界面、能发 HTTP，但**碰不到文件系统**。

同步这件事的全部要素都在 Host 一侧：密钥、profile 文件、WebDAV 连接。而用户要按的按钮在浏览器一侧。

天真的做法是让浏览器半边「知道一切」——把配置整个下发、把文件读进来在浏览器里比对、甚至直接在浏览器里连 WebDAV。这里有三条明确的理由不能这么做：

1. **密钥会进入浏览器**。浏览器里的东西有很长的存活期与很多泄漏面：DOM、扩展、开发者工具的 Network 面板、可能的 XSS。WebDAV 密码和加密口令一旦下发过，就等于它们进过浏览器历史。
2. **WebDAV 会成为跨域问题**。浏览器直连 WebDAV 需要服务器开 CORS，很多 WebDAV 服务商（代码里点名了 坚果云）不开；而且 CORS 预检会让本来一次请求的事变成两次，撞上按请求计费的配额。
3. **状态会分叉**。浏览器持有的状态和 Host 持有的状态一旦各自演化（两个标签页、刷新、后台定时器在跑），合并的基线就会有两个来源，而三方合并对基线的正确性没有余量。

反方向的选择也存在：**干脆不做浏览器半边**，只让用户在 Host 的配置文件里手写 `sync.json`，靠定时器跑。这在本仓库的语境下不可接受：`autoEvery` 的取值、四个份开关、「预览这次会做什么」这些都需要一个界面；而且 `preview` 的价值全部在于「在按下同步之前看见后果」。

还有第三个选项：复用 DSH 的通用配置表单（`settings.configure` 自动投影）。这条路在这里**故意**被关掉了——见下面的 `auto: false`。

## 决策

**浏览器半边是一个纯客户端：它只发 HTTP 到 `/plugin/webdav-sync` 下的固定路由，不读任何 profile 文件，不说 WebDAV 协议，不持有密钥。**

路由前缀与全部端点定义在 `src/wire.ts:12`（两半共享的、零运行时依赖的模块）：

```ts
export const ROUTE_PREFIX = '/plugin/webdav-sync'
```

11 条 `kind: 'exact'` 路由在 Host 半边注册（`src/index.ts:236-308`）：

| 路由 | 方法 | 做什么 |
| --- | --- | --- |
| `/status` | GET | 读回卡片所需的全部状态与配置视图（**不发任何服务器请求**） |
| `/config` | POST | 保存配置 |
| `/check` | POST | 连服务器，报告那里有什么 |
| `/preview` | POST | 算出这次同步会怎么处理，不写任何东西 |
| `/sync` | POST | 跑一次合并（卡片传 `{force:true}`） |
| `/restore` | POST | 用服务器的内容覆盖本机 |
| `/undo` | POST | 撤销上次 restore |
| `/upload` | POST | 用本机覆盖一个不是我们备份的服务器文件 |
| `/install` | POST | 在 profile 目录跑 pnpm |
| `/dismiss` | POST | 清掉上次同步的通知 |
| `/off` | POST | 清空本机设置（服务器文件不动） |

**口令与密码绝不进入响应体。** 卡片拿到的是 `ConfigView`（`src/wire.ts:268-279`），里面只有：

```ts
  passwordSet: boolean
  passphraseSet: boolean
```

`viewOf(config)` 就是这样构造的（`src/engine.ts:883-896`）。对应地，**表单里的密钥输入框永远不回填**：`card-store.ts` 的 `adopt()` 把 `password` 与 `passphrase` 播种成空字符串，而 `configure()` 的契约是**空串 = 沿用已存的那个**（`src/index.ts:145-146`）：

```ts
  if (typeof body.password === 'string' && body.password !== '') next.password = body.password
  if (typeof body.passphrase === 'string' && body.passphrase !== '') next.passphrase = body.passphrase
```

所以要「清空」一个密钥，只能走「关闭同步」（`turnOff` 把 `url` 与 `password` 置空）。这是刻意的取舍：卡片永远没有能力把一个它从未见过的密钥写回去。

**关闭通用配置表单的自动投影。** `apply()` 里（`src/index.ts:184-189`）：

```ts
  // In dsh 0.1.7+, the settings service projects volatile Config fields into
  // forms. auto: false tells the host this plugin ships its own card, which the
  // browser half registers as `plugins.bundle.config`.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
```

通用表单会**读回并回显**字段值，而这个插件的字段里有两个是密钥。关掉投影，界面的唯一来源就是这张卡片。

**两个座位，同一张卡。** `src/client/index.ts` 把同一张 `WebdavSyncCard` 挂在两处：

- `settings.section`，`id: 'webdav-sync'`，`order: 22`（`SECTION_ORDER`，`src/client/index.ts:55`）——注册是**无条件**的，注释理由是「it is the page a user opens when something is wrong and it must still be there to say so」。
- `plugins.bundle.config`，key 是包名 `dsh-webdav-sync`（`PLUGIN_PACKAGE`）——**有条件**：只有 Host 真的在服务这个命名空间时才落座。

```ts
  const served = snapshot.status === 'ready' &&
    (snapshot.view?.namespaces.some(entry => entry.ns === PLUGIN_ENTRY_ID) ?? false)
```

`PLUGIN_ENTRY_ID = 'dsh-webdav-sync'` 与 `cordis.patch.yml` 里的 composition entry id 逐字对应，但**在客户端本地硬编码**——浏览器半边不能 import Host 半边。没组合 Host 半边时插件页上不会留下一个按了没反应的卡片。

**失败永远以数据形式返回，不用 HTTP 状态码区分语义。** Host 侧任何抛出的错误都答 400 加 `{ error: text }`，消息是写给人读的（`src/index.ts`）；客户端 `api.ts` 的每个调用返回 `{ ok: true, ... }` 或 `{ ok: false, error }`，**从不 reject**——因为按钮的 `onChange` 会丢弃它的 promise，reject 就等于无声失败。`HTTP <status>` 只作为「Host 没给消息」时的兜底。

## 影响

正面：

- **密钥在浏览器里不存在**。没有任何响应体、任何 DOM 节点、任何日志包含密码或口令；Network 面板里能看到的只有 `passwordSet: true` 这样的布尔值。
- 没有跨域问题：浏览器只和 DSH 自己的 Host 说话，WebDAV 连接全部发生在 Node 侧，绕开了 CORS 与预检。
- 状态只有一个来源（Host），两个标签页、定时器、卡片读的都是同一份 `sync.json` 与 `sync-state.json`。
- 卡片落座的条件（Host 命名空间在服务中）让「装了客户端没装服务端」这种半配状态不产生幻觉界面。
- 错误消息原文透传到卡片，不需要维护一张状态码到文案的映射表。

负面：

- **界面能力被 Host 路由的粒度锁死**。任何新交互都要先在 `wire.ts` 加路由、在 `index.ts` 注册、在 `api.ts` 加封装——三处。这是「密钥不下发」的直接代价。
- **`/status` 之外的每个动作都是一次往返**，且 `save` 之后要重新拉一次 status 才能刷新视图（`card-store.ts` 的 `save()` → reload）。
- 「留空 = 沿用」这条约定有被误解的风险：用户想「清除密码」却留空提交，得到的是什么都没发生（唯一的清空路径是「关闭同步」）。界面上靠 hint 文案（`passwordHint` / `passphraseHint`）弥补，但它是约定而不是强制。
- 关掉通用配置表单意味着**这个插件的 `profileDir` 与 `autoEvery` 两个 composition 字段不会再出现在通用设置页**，只能在 `cordis.patch.yml` 里手改（卡片能改的是存在 `sync.json` 里的 `autoEvery`，两者是不同的东西）。
- `SECTION_ORDER = 22` 是为了绕开设置页导航栏「没有滚动条 + 固定高度」的限制而调出来的位置（注释在 `src/client/index.ts:50-55`），它依赖宿主当前的视觉实现，宿主改版就可能需要跟着改。
