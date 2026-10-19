# 0017 盲写后的基线只在服务器真的不同的时候回滚

- 状态：已接受
- 日期：2026-10-16

## 背景

有些 WebDAV 服务器不给 ETag。服务器不带版本号，插件就只能靠"写完之后重新读一遍"来判断自己刚写的东西是不是还在那里。

`SyncState` 里有一个 `blind` 字段记着"上次写的时候，服务器上原来是什么样"，本意是：写下之后如果读回来的东西和刚写的不一样，说明有别人在这中间改过，那本地那份基线就作废，回到写之前的基线重新算。

第一版写错了两处。

一是 `push()` 记进 `blind.sum` 的是**写之前**服务器文件的那份字节之和，而 magpie 记的是**刚刚写出去的那份密文**的 `sum`。二是 `syncOnce()` 里只要 `blind` 存在且这次读不是 304，就无条件回滚，而且用完不清空。

结果就是没有 ETag 的服务器上，每同步一次，插件都会把刚建立的基线擦掉，回到"从没有同步过"的状态。下一轮 `first` 又成了真的，于是所有分片都被认成"服务器那边改了"，服务器上的旧副本把本机的编辑盖掉。本机第一次改的东西，第一次同步之后就没了，而且每次同步都会再丢一次。

## 决策

盲写守卫只在"服务器当前的内容确实不是刚写出去的那份"时才回滚基线，并且无论回不回都立刻把 `blind` 清掉——它是一次性的。

```ts
if (state.blind !== undefined) {
  if (read.notModified !== true && (read.data === undefined || sum(read.data) !== state.blind.sum)) {
    state.remote = state.blind.remote
    state.local = state.blind.local
  }
  state.blind = undefined
}
```

`push()` 记的是即将写出的密文的 `sum`：

```ts
const before = { sum: sum(sealed), local: state.local, remote: state.remote }
```

对齐 magpie `internal/davsync/davsync.go:1054-1061`：

```go
if b := st.Blind; b != nil {
    if !unchanged && sum(data) != b.Sum {
        st.Remote, st.Local = b.Remote, b.Local
    }
    st.Blind = nil
}
```

## 影响

正面：没有 ETag 的服务器上，本机第一次的编辑不会再被自己的插件吃掉；只有在别的机器真的插进来改过时才回到旧基线，那是三方合并本来就该做的事。

负面：多一次判断要算 `sum`，即整份密文的 SHA-256，几十 KB 的包可以忽略。

被否决的备选：
- **把 `blind` 一直留着**，靠"每次都回滚"实现保守。没有 ETag 的服务器上本机就永远无法领先服务器，等于关掉同步。
- **在没有 ETag 时根本不同步**。诚实但没用——坚果云、ownCloud 的一些配置就是这样，用户宁可要冲突提示也不要不能用。

## 相关

- `docs/decisions/0006-newer-wins-and-keep-aside.md` —— 冲突时新者胜、败者留档。
- `docs/decisions/0018-serialize-writes.md` —— 并发写入要排队，否则临时文件 rename 会撞车。
