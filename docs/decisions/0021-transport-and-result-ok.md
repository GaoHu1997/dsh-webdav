# 0021 传输成功与操作结果各占一个字段

- 状态：已接受
- 日期：2026-10-16

## 背景

host 的检查和安装接口各自带一个 `ok` 字段：`CheckResult.ok` 表示服务器答话正常且备份可读，`InstallResult.ok` 表示 pnpm 跑成了。它们都走 `200`，失败也是 `200` 加 `ok: false` 加一句人话。

浏览器半边的 `send()` 原本这样写：

```ts
return { ...(payload as T), ok: true }
```

于是 `CheckResult` 自己的 `ok: false` 被传输层的 `ok: true` 覆盖掉了。反过来，`run()` 又把唯一的 `ok` 剥掉之后才把剩下的交给渲染：

```ts
const { ok: _ok, ...rest } = answer as { ok: true } & Record<string, unknown>
this.set({ busy: '', ...describe(rest) })
```

`describe` 读到的是 `undefined`，于是：

- `messageFailed: !(result as { ok?: unknown }).ok` → `!undefined` 恒为真，**连接测试成功被画成失败**；
- `messageFailed: (result as { ok?: unknown }).ok !== true` → 恒为真，**安装成功被画成失败**。

而真正的传输失败（HTTP 非 200）又走不到失败分支，因为 envelope 的 `ok` 被剥掉了。两种失败在界面上长得一模一样，或者都不像。

## 决策

传输结果和业务结果各占一个字段，不共用 `ok`。

```ts
export type Call<T> = { ok: true; data: T } | { ok: false; error: string }
```

`send()` 成功时返回 `{ ok: true, data: payload as T }`；`run()` 和 `load()` 把 `answer.data` 交给渲染。host 的 `ok` 因此原样到达卡片：检查被服务器接受就不标红，host 自己说不行才标红；pnpm 跑成就是成功。

## 影响

正面：一个字段只有一个含义。要判断"这次请求有没有送到"，看 envelope；要判断"事情办成了没有"，看 payload。类型上也不可能再出现 `T & { ok: true }` 这种两个 `ok` 打架的类型。

负面：`Call<T>` 里的 `T` 不再被展平，消费处要写 `answer.data`。这是本项目里唯一的调用方，`src/client/card-store.ts` 有 6 处，都改成了同一个形状。

被否决的备选：
- **把 host 的 `CheckResult.ok` 改名**（比如 `fine`）。要改 wire 协议、README 和两半的注释，而问题出在客户端的类型设计上，不在字段名。
- **剥掉 envelope 之后补一个 `transported: true`**。多一个字段也要多一处判断，比"payload 不被覆盖"更容易记错。
- **靠 `'error' in answer` 判断传输失败**。`{ ok: true, data: {...} }` 和 `{ ok: false, error }` 的判别式应该是那个布尔量，不该靠 in 操作符猜。

## 相关

- `docs/decisions/0008-browser-half-over-routes.md` —— 浏览器半边只见路由。
- `docs/decisions/0013-pending-install-names.md` —— 同样的"布尔要带上名字"思路。
