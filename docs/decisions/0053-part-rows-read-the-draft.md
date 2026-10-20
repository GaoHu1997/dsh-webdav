# 0053 — 「同步内容」的复选框改看草稿，未保存时那一行写「待保存」

- 状态：`已接受`
- 日期：2026-10-21
- 调整：[0031](0031-card-layout-and-chinese-messages.md) 决策二 —— 那一行的复选框仍然存在、仍然是「复选框 + 后置状态文字」，但复选框与状态文字从此都读草稿，不再读宿主报回的 `PartView.synced`

## 背景

用户 2026-10-21 的原话：「同步内容 下，我勾选复选框时，没有反应，保存后又可以看到当时勾选或者取消了，修复这个问题」。

不是开关丢了，也不是保存没生效：是这一行的复选框绑错了源。

- `@deepseek-ai/dsh-client-ui-primitives` 的 `Checkbox` 是**受控**组件，画的就是 `checked` 给它的那个值。行上给的是 `checked={part.synced}`，而 `part` 来自宿主 status 的 `PartView`，`synced` 是 `syncsPart(config, part)`（`src/engine.ts:1099`）——磁盘上那份配置带不带这一份。
- 点一下写的是草稿：`onChange` → `toggle()`（`src/client/card-store.ts:347-349`，`set({ [field]: value, dirty: true })`）。草稿变了，`part.synced` 没变，React 用同一个 `false` 把框画回去，看起来就是「没反应」。
- 保存之后才看见当时的选择：`save()` 把整份草稿 POST 上去，再 `load()` 重读状态（`src/client/card-store.ts:437-443`），新的 `PartView.synced` 才跟上草稿。用户描述的现象——勾选没反应、保存后是对的——正是这一条链的症状。

其余三个复选框本来就读草稿：「保存密码」读 `state.rememberPassword`、「附加目录」那一行读 `state.dirsEnabled`、转发开关读 `state.relayEnabled`。所以问题只在这四行。

约束是这一行上有两个真相：草稿（`CardState` 的 `models` / `defaults` / `plugins` / `patch` / `dirsEnabled`）与宿主的 `PartView`（`synced`，以及 `localChanged` / `remoteChanged`）。而 `status()` 对「配置不带的那一份」是明确表态的：`localChanged:false, remoteChanged:false`（`src/engine.ts:1062-1064` 的注释「A part the configuration does not carry is reported as it stands but never as changed」、`src/engine.ts:1097-1099`）。也就是说 `partStateKey(part)` 对一个被关掉的分片会答「已一致」——原来那句 `part.synced ? partStateKey(part) : 'partOff'` 里的 `part.synced ?` 就是为它兜底的。

## 决策

### 一、四行的复选框读草稿

`checked={state[part.part]}`。`isToggledPart` 已经是类型谓词（`src/client/WebdavSyncCard.tsx:78`，`Part` 去掉 `dirs` 恰好落在 `ToggleField` 里），所以这一句不用断言、也不用手写映射，点下去框会立刻跟着变。

### 二、状态文字问同一个草稿，不一致时写新词「待保存」

新增一个纯函数，四行与附加目录那一行共用：

```ts
function rowStateKey(draft: boolean, view: PartView): WebdavSyncKey {
  if (draft !== view.synced) return 'partUnsaved'
  return draft ? partStateKey(view) : 'partOff'
}
```

- 四行：`const stateKey = rowStateKey(state[part.part], part)`。
- 附加目录：`t(rowStateKey(state.dirsEnabled, dirsPart))`。草稿与状态一致时结果与原式**完全相同**（`synced` 为真走 `partStateKey`，为假走 `partOff`），只有刚翻过开关、还没保存时才换成「待保存」。

新词 `partUnsaved`：中文「待保存」、英文「Not saved yet」。

为什么不用已有的词代打：`partOnlyHere`「仅本机有改动」、`partOnlyThere`「仅服务器有改动」、`partSynced`「已一致」、`partOff`「不同步」这四个都在回答**已保存的那份配置**——`synced` 说的是磁盘上带不带，`localChanged` / `remoteChanged` 也是拿存下来的哈希比出来的。勾上之后还没保存，服务器上到底有没有这一份、两边是不是真的都动过，此刻没有任何人知道；「待保存」只说真正成立的那件事。`partSynced`（「已一致」）是最不能用的一个：它会被读成「已经生效」。

### 三、「待保存」不另配色

`.partStateBoth` 那种 warning 色只留给「两边都有改动」，那是一个需要人来判断的冲突；「待保存」不是判断，是「等你按保存」。所以它走 `.partState` 本来的三级色，字变了，颜色不动。

### 四、不做「点击即保存」

否决。勾一下就是一次写请求：翻三份配置会变成三次落盘，而写操作之间有排队与合并的语义（[0018](0018-serialize-writes.md)），一次同步可能正好在跑。用户要的是「点了有反应，保存后生效」，不是「点一下落一次盘」。

### 五、不维护第二份 checked

否决「在组件里存一个自己的勾选状态覆盖它」。那就是第二份真相，要和 `toggle()`、`adopt()`、`reset()` 三处对齐；草稿本来就在手上（`state[part.part]`），读它是同一件事的既有一份。

### 六、保存路径一个字不动

`save()` 照旧把整份草稿 POST 上去再重读状态，所以保存之后状态文字会自己回到 `partStateKey` 那四个词，「待保存」随之消失。这次改的只有「这一行画的是谁」与「不一致时说什么」。

## 影响

- **正面**：勾选当场有反应。用户描述的两段现象（勾选没反应 / 保存后能看到当时的选择）现在是同一件事——勾上就已经是勾上的样子。
- **正面**：状态文字与它旁边那个框终于说的是同一件事。不一致的时候不再借用「已一致」或「不同步」这类只对已保存配置成立的说法。
- **负面**：保存之前，行上的勾与文字描述的是**将要**写入的样子，而「预览」「同步」用的仍是宿主手上那份配置。两处会在保存前短暂不一致——这是草稿本来的性质，卡片底部的 `saveLegend`（「保存以上设置（服务器、自动同步、同步内容）」）与 `dirty` 时才可点的「放弃改动」是既有的提示。
- **负面**：字典多一个键，中英各一条，`WebdavSyncKey` 联合类型多一项。`en` 是 `Record<WebdavSyncKey, string>`，漏写编译不过，所以漏不了。
- **验证**：新增 `tests/part-rows.spec.tsx`，用 `renderToStaticMarkup` 渲染 settings 座（宿主状态用 `tests/client-card.spec.ts` 那套 stub `fetch` + `WebdavSyncCard.actions()` 造出来），断言四件事：勾上一个宿主没带的分片 → 该行的框带 `checked` 且文字是「待保存」；勾掉一个宿主带着的分片 → 框不带 `checked`、文字同为「待保存」；草稿与状态一致时仍是「不同步 / 已一致」；附加目录与其余四行同判。把 `src/client/WebdavSyncCard.tsx` 换回改动前，这四条里三条会红——回归测试确实钉住了这个 bug（0031 记的「UI 改动没有自动化测试守护」由此对「同步内容」这几行不再成立）。
- **验证**：`pnpm typecheck`、`pnpm test`（13 个文件 372 条）与 `pnpm build:all` 全绿。
