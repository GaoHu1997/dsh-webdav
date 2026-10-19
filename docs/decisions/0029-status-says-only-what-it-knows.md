# 0029 状态只回答它真知道的事

- 状态：已接受
- 日期：2026-10-16

## 背景

`status()` 不去问服务器 —— 每开一次卡片就发一次请求不划算。它只有两份基线：上次同步后本机各分片的哈希（`state.local`），以及当时服务器上各分片的哈希（`state.remote`）。

原来的判定是：

```ts
remoteChanged: !first && here !== there
```

其中 `there` 取自 `state.remote`。问题在于：**成功同步之后 `state.local` 和 `state.remote` 就是同一份东西**。所以「本机现在的哈希和上次服务器上的不一样」和「本机改过了」是同一个问题，两行都会亮。

卡片把两个标志合成一个键（`src/client/WebdavSyncCard.tsx:72-75`）：

```ts
if (view.localChanged && view.remoteChanged) return 'partBoth'
```

于是只在本机改了一次的正常场景，文案写着「两边都有改动」/ `Changed on both`。这句话会让人以为另一台电脑也在动，接下来可能去查一个不存在的问题。

## 决策

两个标志各答一侧，各自和「上次同步时是什么」比：

```ts
const here = local[part] ?? null
const there = knownRemote?.[part] ?? null
const was = known?.[part] ?? null
localChanged: !first && here !== was
remoteChanged: !first && was !== there
```

`was` 取 `state.remote`，也就是上次同步时服务器上那份。判据变了：「上次同步到现在，这一边动了没有」。

代价要说清楚：**这样算出来的 `remoteChanged` 不是服务器现在的真相**。条件读返回 304 时 `state.remote` 不会更新，服务器被人改过、本机又没动，两个标志都不会亮 —— 这是对的，因为本插件并没有证据。真要知道服务器动没动，得用 `preview`（它会真的读一次服务器）。这条限制写在 `src/engine.ts` 的注释里。

## 影响

正面：纯本机编辑只亮 `partOnlyHere`（「仅本机有改动」/ `Changed here only`），不再谎报两边都动；两个标志互斥，`partBoth` 变成真正需要人工看一眼的情形。

负面：`remoteChanged` 的语义从「看起来不一样」收窄成「两边记录不一致」，字符串含义比原来弱；单看卡片无法区分「服务器动了」和「上一次合并留下了分歧」。要真答案就点 Preview。

被否决的备选：
- **让 `status()` 也去问服务器**。卡片每次打开都变成一次完整读 + 解封，600,000 轮 PBKDF2；而且状态显示会依赖网络，服务器不可达时卡片就空白。
- **改文案了事**（保留两个标志都亮，把 `partBoth` 改成「本机有改动」）。同一份数据两种读法仍然是两个标志，日志和后续判断会继续踩坑。

## 相关

- `docs/decisions/0011-state-key-isolation.md` —— `state.local` / `state.remote` 各是什么。
- `docs/decisions/0006-newer-side-wins.md` —— 合并时真正判定「服务器动过」的地方。
