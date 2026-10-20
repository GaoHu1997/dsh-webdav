# 0043 — 转发地址排成纯文本加一个复制图标，「立即同步」改成带强调色的文字按钮

- 状态：`已接受`
- 日期：2026-10-20
- 相关：[0042](0042-relay-section-one-address-box.md)（本条取代它第三节「地址是一个只读文本框」与「复制用描边按钮」；它关于端口收进地址、账号并排、删掉说明文字的决策仍然有效）、[0031](0031-card-layout-and-chinese-messages.md)（本条为「立即同步」松开它「ghost 在这张卡片里彻底不用」的口径）、[0041](0041-relay-reuses-sync-config.md)（转发复用同步配置，授权、保存与账号生成规则不变）

## 背景

实机用下来报了三件事：

1. **勾选本机转发、保存后勾选消失。** 查下来不是代码里的开关丢了，是两端版本不一致：浏览器里跑的半边（带转发区、保存时发 `relayEnabled`）比宿主里跑的半边新。旧宿主的 `configure()` 不认识这两个字段，直接丢掉，回一句 `{message:'已保存'}`，于是卡片既不报错、又读不到自己刚存的东西。
2. **「立即同步」是个实心按钮，太丑。** 要求：直接用文字按钮，但也不能直挺挺地放在那里，让人看不出是个按钮。
3. **转发地址不该用文本框。** 复制按钮直接跟在连接后面，用复制图标即可。

## 决策

### 一、转发地址是纯文本，复制是一个图标按钮

> **本节有两处被 [0045](0045-relay-value-copy-icons.md) 调整**：复制图标现在紧跟地址、不再被 `flex: 1` 推到行尾（`.relayAddress` 改成 `flex: 0 1 auto`），标签也从通用的「复制」改成「复制地址」，好与账号的两个复制图标区分。`<code>` + 图标按钮 + `writeClipboard` + 一秒对勾反馈这套骨架不变。

`RelayPanel` 里那个 `<input readonly>` 换成 `<code className={css.relayAddress}>`（等宽、可选中、`overflow-wrap: anywhere` 兜住长地址），后面紧跟一个只带图标的 `Button`（`variant="ghost" size="sm"` 加 `css.relayCopy`：24×24、无内边距）。

- **复制怎么走**：用原语的 `writeClipboard(address): Promise<boolean>`，而不是 `navigator.clipboard` 直调 —— 它在 Clipboard API 不可用时回退到 `execCommand('copy')`，并且**把失败说出来**。
- **成功与失败各有表现**：`copied === true` 时图标换成 `IconCheckOutlineRegular`，一秒后（`COPIED_MS = 1_000`，与宿主别的复制按钮一致）变回复制图标，Tooltip 与 `aria-label` 同时是「已复制」；`copied === false` 时图标不变，旁边留一句 `relayCopyFailed`（「复制没成功，请手动选中复制」，`role="alert"`）。定时器在卸载时清掉（`useRef<number>` + `useEffect` 的清理函数）。
- **为什么不用 `useCopyFeedback`**：它静默失败（被拒绝时什么也不说），而地址是要落到另一个程序里的东西，复制没成功必须说出来。
- **为什么不用原生的 `<button>`**：宿主自己的 `CodeCard` 用原生按钮，是因为它连 `Button` 的尺寸变体都不需要；这里要的是原语的 `ghost` 悬停底色与焦点环，而 `size="sm"` 的 28px 高度必须让位给 24px —— 靠 `button.relayCopy`（多一个类型选择器）提高特异性压过 `.button`/`.sm`，不靠样式表的先后顺序。
- **被否决的备选**：保留输入框、只把「复制」两个字换成图标。要求里明确说了不要文本框；而且没人会往这个框里打字，`readonly` 只是把一个字符串伪装成可编辑字段。
- **被否决的备选**：用 `<span>` 而不是 `<code>`。`<code>` 自带「这是机器要读的字面量」的语义，也正好继承卡片里既有的等宽字体口径。

### 二、「立即同步」是带强调色的文字按钮

> **本节被 [0048](0048-sync-actions-are-text-buttons.md) 推广到整行**：另外五个同步动作也改成了文字按钮，颜色按「这一次会动谁」分成强调 / 警告 / 普通三档，「唯一着色的一项」因此改成「唯一的强调色」。`ghost` + 悬停底色 + 补焦点环这套骨架不变。

卡片底部的同步动作里，「立即同步」从 `variant="primary"` 改成 `variant="ghost" size="sm"` 加 `css.syncAction`：`color: var(--dsw-alias-state-business-primary)`（设计系统里当文本强调色用的那个）、`font-weight: 500`、`height: auto`，悬停时给一层 `--dsw-alias-interactive-bg-hover` 底色。它仍然是这一行里唯一着色的一项。

- **为什么这样就不算「看不出是按钮」**：0031 之所以把 ghost 从这张卡片里删掉，是因为**静止**的 ghost「既无边框也无底色，只剩一行字」。这里加上强调色（同行里唯一带颜色的）与悬停底色，「这一行字是可点的」由颜色说了；而整个描边框正是用户点名嫌丑的东西。
- **被否决的备选**：`variant="outline"`。这就是原来那个「框」。
- **被否决的备选**：纯 `ghost`、不加任何强调。正是 0031 说的那件「看不出是按钮」的事。
- 0031「每组动作只有一个主操作」的口径不变，只是把「实心按钮」放宽为「实心按钮或带强调色的文字按钮」：整张卡片仍然只有一个实心主操作（保存，以及确认框的「确定」）。

### 三、勾选消失不改代码，改的是部署

`src/client/card-store.ts` 的 `adopt()` 里 `view.config.relayEnabled ?? false` 是有意的兼容行为：宿主比插件旧时读作「没开」。真正的修法是让两端同版本 —— 重新构建（`pnpm run build:all`）、重装进 profile、刷新页面。实机探针已验证新版宿主：对 `/plugin/webdav-sync/config` POST `{relayEnabled:true, relayPort:3426}` 后，`/status` 回 `relay: { enabled: true, port: 3426, url: 'http://127.0.0.1:3426/dav', listening: true, user: 'dsh…' }`，再 POST `{relayEnabled:false}` 即恢复原状（端口 3426 不再监听）。

被否决的备选：在卡片里加一句「宿主版本太旧」的提示。判定「旧」需要协议里有个版本号，而插件现在没有这个约定；`relayEnabled` 缺失既可能是旧宿主，也可能是用户在其他地方保存过一次而没带这个字段，两者在同一个 `/status` 里区分不出来。

## 影响

- **正面**：地址、复制图标、账号现在在同一行里从左到右读完，复制路径唯一；地址是文本，可以直接选中，也可以点图标。
- **正面**：「立即同步」不再是一个和「保存」抢注意力的实心块，但仍然是这一行里唯一带强调色的动作。
- **正面**：复制失败不再静默 —— 这是 0042 那一版（只读文本框 + 描边「复制」）没有的一层。
- **负面**：`RelayPanel` 又把「上一次复制成功没有」的状态拿了回来（一个 `useState<Copied>`、一个定时器、一个卸载清理），比 0042 那时的无状态版本多三样东西；这是「失败要说出来、成功要有一秒反馈」的代价。
- **负面**：`size="sm"` 的 28px 与 `css.relayCopy` 的 24px 靠选择器特异性分胜负，将来若原语改了类名结构，这一处的高度可能悄悄回到 28px。
- **负面**：旧宿主的兼容行为仍然静默，用户只有在重装并刷新之后才会看到两端一致。
- **验证**：`pnpm run typecheck`（`tsc -p tsconfig.client.json --noEmit`）通过；`pnpm test` 12 个文件、360 例全部通过（`tests/relay-panel.spec.tsx` 改为断言 `<code>` 与图标按钮的 `aria-label`）。README 的卡片说明、浏览器半边一节与「开启与复制」三步同步更新。
