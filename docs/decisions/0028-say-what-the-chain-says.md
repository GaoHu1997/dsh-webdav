# 0028 报错时沿着 cause 链说话

- 状态：已接受
- 日期：2026-10-16

## 背景

`message(cause)` 原本只有一句：

```ts
if (cause instanceof Error) return cause.message
return String(cause)
```

Node 里绝大多数真实故障都带着 `cause`：`rename` 撞上一个还开着的文件（`EPERM`）、目录被另一个进程锁住（`EBUSY`）、权限不足（`EACCES`）。这些信息全在 `cause` 里，被丢掉了。用户在 Windows 上看到的是一句 `EEXIST: file already exists, rename 'C:\Users\...\sync-state.json.tmp' -> 'C:\Users\...\sync-state.json'`，路径是临时文件——临时文件被谁占着、占着的是哪个真文件，答案就在外层那半句话里。

`src/dav.ts` 的 `describeCause()` 已经在做同样的事（`${cause.message} (${nested.message})`），只是只跟了一层。状态侧和存储侧没有跟上，同一个插件里两种风格。

## 决策

`message()` 沿 `cause` 链往下走，最多取 5 条，去重之后用 ` — ` 连接：

```ts
export function message(cause: unknown): string {
  const parts: string[] = []
  let current: unknown = cause
  while (current !== undefined && current !== null && parts.length < 5) {
    const text = current instanceof Error ? current.message : String(current)
    if (text !== '' && !parts.includes(text)) parts.push(text)
    current = current instanceof Error ? (current.cause as unknown) : undefined
  }
  return parts.length === 0 ? '' : parts.join(' — ')
}
```

去重是有意的：`new Error('could not write the state', { cause: parseError })` 里内层那句话往往被外层整句包含过一次，重复印出来不增加信息，只会让真正有用的那半截更难找。上限 5 条防的是环——`cause` 指向自己不会抛错，只会让这段代码不返回。

空串的情况保留原来的行为（`String(cause)` 对 `null` 会得到 `'null'`，但那不是这条链会遇到的输入）。

## 影响

正面：Windows 上最常见的一类失败现在能一次说全，用户不用去看临时文件名猜。状态和存储两侧的错误信息风格与 `src/dav.ts` 一致。

负面：失败信息变长。5 条上限和去重把它限制在可读范围内——真正需要看全的场景会去看日志，而界面上的信息只要求能指对方向。

被否决的备选：
- **只跟一层**（照抄 `describeCause`）。链断在第二层的情况照样丢信息，而跟更多层的成本和一层几乎一样。
- **把 cause 链原样倒出来**（`error.cause` 的 `toString()`）。会带出堆栈和一堆用不上的属性，而且一样要去重。
- **在 `recordFailure()` 里记整个错误对象**。状态文件是要跨会话读的，不该塞不可序列化的东西。

## 相关

- `docs/decisions/0027-damaged-is-not-missing.md` —— 这里的新错误信息正是它那句话的来处。
- `docs/decisions/0016-find-pnpm-on-path-first.md` —— pnpm 的输出走文件描述符，不走管道（`src/install.ts`）。
