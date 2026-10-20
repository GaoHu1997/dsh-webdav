# 0055 — 安装报告自己带一个「关闭」，不再只能靠「放弃改动」消失

- 状态：`已接受`
- 日期：2026-10-21
- 调整：[0013](0013-pending-install-names.md) 的安装提示流程——补上它一直缺的收尾

## 背景

用户 2026-10-21 的原话：「当同步完成后，提示有插件未安装，安装完成后，安装日志、提示等都还在页面上，需要有一个地方可以关闭」。

现场是这样一条链：

- 同步带来一份 `plugins`，本机缺几个包，`status()` 报 `pendingInstall: true` 与 `pendingNames`（`src/engine.ts:916` 的 `pendings()`），卡片在 `state.view?.pendingInstall === true` 处画一条「有插件尚未安装：… [安装]」。
- 点「安装」走 `install()`（`src/client/card-store.ts:558-564`）：`requestInstall()` 回来后把 `output` 写进 `state.installOutput`，再 `load()` 重读状态。
- 重读之后 `pendingInstall` 自己变 `false`（包已经装上了，`missingPlugins` 返回空），那条黄色提示确实消失了。
- **但安装输出没有消失。** 它是 `state.installOutput !== ''` 时渲染的一个 `<p>` 加一个 `<pre>`，而清掉它的只有 `reset()`（「放弃改动」）——那个按钮的语义是「丢掉未保存的设置」，跟一段安装日志毫无关系。而且它只在 `dirty` 时可点，用户装完插件、没有改过任何设置时它是灰的。

于是装完之后页面上永久留着一块日志，唯一的出路是「放弃改动」或者刷新整页。用户说的「需要有一个地方可以关闭」，就是这个缺口。

## 决策

### 一、报告自己带一个「关闭」

安装输出那一块改成三段：一句话（成功/失败）+ 一个 `Button variant="outline" size="sm"` 的「关闭」+ `<pre>` 里的日志。

```tsx
<div className={css.outputBlock}>
  <div className={css.outputHead}>
    <span className={state.installFailed ? css.failed : css.note}>{…}</span>
    <Button variant="outline" size="sm" onClick={() => props.closeOutput()}>{t('outputClose')}</Button>
  </div>
  <pre className={css.output}>{state.installOutput}</pre>
</div>
```

放在那句话的同一行右侧，而不是压在日志底下：日志可以很长，按钮跟着日志滚下去就找不着了。新增 `.outputBlock`（纵向 flex，`gap: 6px`）与 `.outputHead`（横向 flex，两端对齐）两条 CSS。

新词 `outputClose`：中文「关闭」、英文「Close」。用 `outline` 而不是文字按钮，是因为它旁边没有任何别的动作，`outline` 在这一块里是唯一的主次关系（[0048](0048-sync-actions-are-text-buttons.md) 只规定同步动作那一行）。

### 二、`closeOutput()` 是本机动作，不发请求

```ts
closeOutput(): void {
  this.set({ installOutput: '', installFailed: false })
}
```

对比 `dismiss()`：那个要 POST `ROUTE_DISMISS`，因为通知（`state.notice`）是宿主记在状态文件里的，浏览器半边关不掉。安装日志从头到尾只活在 `CardState` 里，宿主那边没有对应物，所以关它就是清两个字段——不走网络、不重读状态、不碰别的字段。测试断言 `sent` 为空就是这个意思。

### 三、成功/失败改用自己的 `installFailed`，不再借 `messageFailed`

原来那一块读 `state.messageFailed`。`messageFailed` 是「最近一次动作失败了没有」的通用标记：`check()` 失败会把它置真，`install()` 成功会把它置假。于是会出现两种错配：

- 装完（成功）之后随便失败一次别的调用（比如 check 被服务器拒了），屏幕上那段「安装完成」的日志会被重新染色成红色的「安装未成功」。
- 反过来，一次失败的安装之后若某个调用成功把它置假，日志又会变成绿色。

新增 `installFailed: boolean`，只在 `install()` 的 `describe` 里按 `result.ok !== true` 写，`closeOutput()` 与 `reset()` 清掉。`messageFailed` 恢复它本来的职责。`tests/client-card.spec.ts` 里那条「keeps the report readable after a later failure from something else」钉的就是这个。

### 四、不自动消失，也不设超时

否决「装完 5 秒自动关」与「下一次成功同步时顺手清掉」。安装日志是**证据**：`pnpm` 失败时真正的原因（网络、registry、peer 冲突）就在里面，人得能读、能复制。自动消失等于把人正要看的字吃掉。什么时候关由人决定，这就是这次加的那个按钮。

### 五、`reset()` 照旧清它

「放弃改动」本来就把 `installOutput` 与 `installFailed` 一起清掉，这次只是把字段从 `messageFailed` 换成 `installFailed`，语义没变：那是一个「把卡片恢复到宿主状态」的动作，日志属于卡片自己的临时状态。

## 影响

- **正面**：用户报的那条现象没有了。安装完成后，报告旁边就有一个「关闭」，点一下这块就干净了，其余部分原样留着（测试断言关掉之后「模型供应商与模型」和「保存」都还在）。
- **正面**：日志的颜色与它自己的那次安装绑定。别的调用成功或失败都不会再改写它。
- **负面**：卡片多一个状态字段（`installFailed`）与一个动作（`closeOutput`），`CardActions` 与 `CardState` 各加一项，`actions()` 的字面量也多一行。
- **负面**：报告不会自己消失，所以一个人装完不看、不关，它就一直占着版面。这是第四条决策的代价，也是本意。
- **验证**：`tests/part-rows.spec.tsx` 新增 `describe('the install report')` 两条，用 `renderToStaticMarkup` 渲染真实卡片：装完之后报告的块里能找到 `outputClose`、日志文字还在；调用 `closeOutput()` 之后日志与按钮都不见了，而「模型供应商与模型」「保存」仍在。`tests/client-card.spec.ts` 的 `closes the install report without touching anything else` 断言 `sent` 为空（本机动作）、`view` 与 `dirty` 都没动。`pnpm typecheck`、`pnpm build`、`pnpm test`（14 个文件 406 条）全绿。
