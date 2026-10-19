# 0031 同步卡片按「设置 / 动作」重排，宿主提示统一中文

- 状态：已接受
- 日期：2026-10-17

## 背景

用户对同步卡片提了五条（原文见下），核心是「卡片占的地方太大、按钮混在一起、提示不是中文」：

1. 自动同步的时间选择改用一个下拉框即可，卡片占用空间太大。
2. 同步内容设计成「前面是复选框，后面是当前是否一致」，不使用按钮开关。
3. profile 目录具体在哪个目录，在同步内容的条目下灰色展示即可，不用单独展示。
4. 把 WebDAV 本身的保存等操作按钮和同步按钮分开，本身的放到卡片最外面。
5. 把操作提示、返回提示等都换成中文。

改动前的形态：自动同步是 `SegmentedControl`（`AUTO_CHOICES` 有 5 个选项，横排铺开）；同步内容每条是 `Switch`；profile 目录等五行路径单独占一个 `## 路径` 小节；卡片底部一个 `footer` 里并排 9 个按钮（保存/放弃改动/测试连接/预览/立即同步/用服务器覆盖本机/撤销/用本机覆盖服务器/关闭同步），保存和同步动作混在一起；宿主侧发给用户看的消息（`src/dav.ts`、`src/crypto.ts`、`src/engine.ts`、`src/index.ts`、`src/install.ts` 等）全是英文。

第二轮（用户看到改完的卡片之后）又提了两条：一是那五行路径「仅保留上次同步时间即可」；二是问卡片底部常驻的两行提示「只清空本机设置，服务器上的文件保持原样。」（`turnOffHint`）与「清单同步过来了，包要从本机拉取：在 profile 目录里运行 pnpm install。」（`installHint`）是什么意思，「如果是自动的，移除」。

第三轮（再看一遍卡片之后）又提了四条：按钮「有的是有框的按钮，有的不是，需要统一」；「关闭同步」的配置并进自动同步下拉框是否更合适；删掉地址示例里的 Nextcloud 一条，且「所有的描述文字都放到标题下面，不要放到输入框下面」；「同步内容」每一条要有小字说明同步了什么，「让用户能够判断是否需要打开」。

约束：`@deepseek-ai/dsh-client-ui-primitives` **没有下拉组件**（`lib/` 下只有 Button/Input/Checkbox/Switch/SegmentedControl/Tag 等，没有 Select），所以下拉必须自绘。宿主侧的错误消息是**直接给人看的**：`src/index.ts` 的路由把 `error.message` 原样放进 400 响应，卡片把它显示成 `state.message`；`locales.ts` 的字典只覆盖浏览器半边，覆盖不到它。

## 决策

### 决策一、自动同步用原生 `<select>`

`<select id="webdav-sync-auto" className={css.select}>`，选项仍由 `AUTO_CHOICES`（`src/wire.ts:241`，`[AUTO_MANUAL = -1, 3, 15, 30, 60]`）生成，文案沿用 `autoManual` / `autoEvery({ n })`，`onChange` 走既有的 `props.setAuto(Number(value))`（`setAuto` 里的 `AUTO_CHOICES.includes` 校验不动）。`.select` 的视觉照抄 `Input.module.css`：`height: 32px`、`padding: 0 8px`、`border: 0.5px solid var(--dsw-alias-border-l4)`、`border-radius: var(--dsw-radius-md)`、`background: var(--dsw-alias-bg-layer-1)`，补 `:focus-visible` 与 `:disabled`。

否决了另外两条：(a) 自己写一个自定义下拉（要接管键盘、点击外部关闭、焦点管理，收益只是一个箭头图标）；(b) 保留 `SegmentedControl`（正是要压缩的那块空间）。原生 `<select>` 在中文选项下宽度只有原来的一小半，且默认就带键盘与无障碍行为。

第三轮把「关闭同步」也并进了这个下拉框（见决策八），所以它现在是六个选项。

### 决策二、同步内容是「复选框 + 后置状态文字」，不是开关

每行改为 `<Checkbox checked={part.synced} label={t(PART_NAME[part.part])} ... />` 后跟一个 `.partState` 状态文字（`partSynced` / `partOnlyHere` / `partOnlyThere` / `partBoth`，关掉时是 `partOff`；`partBoth` 额外加 `.partStateBoth` 走 warning 色）。基础库的 `Checkbox` 渲染的就是 `<label><input type="checkbox">文本</label>`，复选框天生在文本前，正是要的形态。同一轮的「记住密码」也从 `Switch` 换成 `Checkbox`——用户说的是「不使用按钮开关」，留一个开关在同一张卡片里会自相矛盾。`Switch` 与 `SegmentedControl` 因此从 import 里去掉。

复选框表达「要不要同步这一份」，后面的文字表达「现在一不一致」，两件事分开写在两处，比原来一个 `Switch` 同时暗示两种含义更清楚。

### 决策三、路径信息不再展示，只留一行上次同步时间

先按用户第 3 条把 `## 路径` 小节删掉，五行（`profileDir` / `patchFile` / `packageFile` / `stateDir` / `lastSync`）挪到「同步内容」条目列表下方的 `.meta` 灰色网格里。用户看到实物后要求「这些仅保留上次同步时间即可」，于是这一块也整体删掉，只留一行：

```tsx
<p className={css.hint}>
  {state.view?.last === undefined ? t('neverSynced') : t('lastSync', { at: whenText(state.view.last) })}
</p>
```

顺带修掉一个真 bug：原来那行把带 `{at}` 占位符的 `lastSync` 当**标签**用却没传参数，界面上真的显示成「上次同步：{at}」。`whenText` 用 `new Date(at).toLocaleString()` 把宿主存的 UTC ISO 串换成本机时钟读得懂的本地时间（解析不出来就原样显示）。

判定「这四个目录不必展示」的依据：它们是排查问题时才需要的实现细节，日常用户对着它们没有可做的动作；`README.md` 与 `paths.ts` 都写明了 profile 目录的定义（默认 `~/.dsh/profiles/<name>`，可用 `DSH_PROFILE_DIR` 覆盖），要查的人有地方查。`state.view.paths` 仍由宿主返回，只是这张卡片不再渲染它（同理 `WebdavSyncFace.copy` 与 `src/client/index.ts` 里的 `writeClipboard` 已无调用者，一并删除）。

### 决策四、删掉卡片底部两行常驻提示

- `turnOffHint`（「只清空本机设置，服务器上的文件保持原样。」）：与「关闭同步」自带的确认框 `confirmOff`（「关闭同步？服务器上的文件不会被删除。」）说的是同一件事，而确认框是该动作必经的一步，常驻一行只是噪音。
- `installHint`（「清单同步过来了，包要从本机拉取：在 profile 目录里运行 pnpm install。」）：这是**过时的错误指引**。卡片本来就有「安装缺少的插件」按钮，宿主侧 `/install` 会自动调用 pnpm（`src/install.ts`，按 `$DSH_PNPM` → `$DSH_RESOURCES_DIR/runtime/pnpm/bin/pnpm.cjs` → PATH 找可执行文件），缺包时 `pendingInstall` 已经列出包名并给出按钮。让用户自己去敲命令，是叫用户做事倍功半的事。

两个字典键连同 `WebdavSyncKey` 里的两行一起删掉（zh 与 en 同步删，这是个只在浏览器半边用的键，宿主不引用）。

### 决策五、保存/放弃改动挪到卡片最外层，与同步动作分家

「测试连接/预览/立即同步/用服务器覆盖本机/撤销上次恢复/用本机覆盖服务器」六个同步动作留在「同步内容」小节末尾的 `.footer` 里（原来还有第七个「关闭同步」，第三轮挪进了自动同步下拉框，见决策八）；「放弃改动/保存」移到整张卡片的最后，装在新类 `.cardFooter` 里（`border-top: 1px solid var(--dsw-alias-border-l2)` 起一条分隔线），左侧加一句 `saveLegend`（zh：`保存以上设置（服务器、自动同步、同步内容）`），顺序是「放弃改动」在左、「保存」在右（主按钮靠右、破坏性动作不贴主按钮）。

理由是「保存」保存的是整张卡片的草稿（地址、自动同步、同步哪些内容三节），不属于同步动作集合；原来的九宫格里它离「用本机覆盖服务器」只隔几个像素，误点代价不小。否决了把保存做成 sticky 底栏：卡片在设置页里跟着页面滚动，sticky 会盖住下面的内容与提示。

### 决策六、宿主侧提示统一改成中文，浏览器半边继续走字典

`src/dav.ts`、`src/crypto.ts`、`src/engine.ts`、`src/index.ts`、`src/install.ts`、`src/paths.ts`、`src/state.ts`、`src/store.ts`、`src/client/api.ts` 里所有**会送到人眼前**的消息改写成中文，包括 `ConfigureBody` 校验、HTTP 兜底、pnpm 输出、恢复/上传的拒绝理由等；`src/wire.ts` 的 `PART_LABELS.patch.zh` 顺手补上漏掉的空格（`'其余profile配置'` → `'其余 profile 配置'`）。

保留英文的是：代码标识符、effect 标签（`'webdav-sync: auto-sync timer'` 等）、`src/client/locales.ts` 里的 `en` 字典、以及所有注释。`en` 字典必须留着——`WebdavSyncKey` 以 zh 为键源，`en: Record<WebdavSyncKey, string>` 缺键就编译不过，删掉它等于删掉英文界面这条路。

否决了「让宿主消息也走 `locales.ts`」：宿主没有 locale 注入点（`inject` 是浏览器半边的 `['slots','locale','configForms']`），而 `engine.ts`/`dav.ts` 的错误在没有界面的场景（测试、日志）里也会出现，那边没有字典可用；把文案散到两套机制里，只会让「这句话在哪」变成一个新问题。

### 决策七、测试断言跟着改中文正则，不为 UI 加 DOM 测试

`tests/*.spec.ts` 里断言宿主文案的正则逐条换成中文（`dav.spec.ts`、`engine.spec.ts`、`crypto.spec.ts`、`index.spec.ts`、`state.spec.ts`、`store.spec.ts`、`install.spec.ts`）。`tests/client-card.spec.ts` 只驱动 `src/client/card-store.ts`，不渲染 TSX，因此不受这些 UI 改动影响——它里面 `'the server said no'`、`'pnpm finished'` 之类的英文串是假 fetch 自己造的回复，不是宿主文案。同理，删掉 `pathProfile` 等字典键、删掉 `copy`/`writeClipboard` 也不会打破任何测试：全仓没有任何测试引用它们。

这一轮**没有**为卡片的 DOM 结构新增测试：测试环境里没有渲染 TSX 的设施，这些改动本身是版式与控件替换，逻辑仍全部落在已被覆盖的 `card-store.ts` 上。代价是这部分的回归暂时只能靠人工看。

### 决策八、按钮只有两种形态：主操作 `primary`，其余一律 `outline`

第三轮的第一条是「有的是有框的按钮，有的不是，需要统一」。改动前三节混用了三种：`check`/`preview` 是 `outline`，`syncNow` 是 `primary`，`restore`/`undo`/`upload`/`turnOff` 是 `ghost`（`ghost` 静止时既无边框也无底色，只剩一行字，看起来不像按钮）。现在规则收成一条：**每组动作里只有一个 `primary`（保存、立即同步、确认框的「确定」），其余全部 `outline`**，`ghost` 在这张卡片里彻底不用了（「放弃改动」「取消」也一并从 `ghost` 改成 `outline`）。

否决两种做法：(a) 全卡片只用一种变体——那样「立即同步」和「撤销上次恢复」看起来同等重要，而后者大多数时候是 disabled 的；(b) 保留 `ghost` 只统一次要按钮——`ghost` 与 `outline` 并排时仍会被读成「有的有框、有的没有」，正是用户看到的那件事。

### 决策九、「关闭同步」并进自动同步下拉框的最后一项

下拉框末尾加 `<option value={AUTO_OFF}>`（`AUTO_OFF = 'off'`，与 `AUTO_CHOICES` 里的数字区间不冲突），文案 `autoOff`（zh：`关闭同步…`，省略号表示后面还有一步）。选到它时 `onChange` 不去调 `setAuto`，而是调既有的 `props.askOff()`，走的还是原来那个确认框（`confirmOff`）与 `/off` 路由——语义、清空范围（只清 `url` 与 `password`）、服务器文件保持原样都一字未变，变的只是入口。`<select>` 仍由 `state.autoEvery` 受控，所以点了「关闭同步…」确认框弹出、下拉框自己回到当前区间，不会停在一个「值等于 off」的假状态上。

顺带删掉 `turnOff` 这个字典键（原来只给那个按钮用，现在没有调用者了）。

这么排的理由：「关闭同步」在用户心里就是「不要自动同步了」的一种取值，和「仅手动 / 每 N 分钟」是同一个问题的答案；单独摆一个按钮，等于把同一件事的优势选择拆到两处。代价是这个动作的**可发现性**下降了——它藏在一个下拉框的末尾，不看选项不会发现。接受这个代价，因为「关闭同步」是低频动作，而误点它会清掉本机地址与密码，藏深一点反而更安全；确认框仍在，不会误伤。

### 决策十、说明文字一律在小节标题下面，输入框下面不留字

第二轮之后「服务器」小节的 `urlHint` / `passwordHint` / `passphraseHint` 分别跟在各自输入框后面，把三组输入框在视觉上切碎了。现在四句（含 `rememberPasswordHint`）合成一个 `.hints` 无序列表，紧贴 `## 服务器` 标题（`<h4 className={css.legend}>`）正下方，输入框成组排下去，中间不再夹字。`rememberPasswordHint` 也进这个列表、不再藏在 `Checkbox` 下面：它讲的是「保存密码」这个选项的行为，属于这一节的规则说明，跟另外三条同性质；留在复选框下面会让那一行比其他行高出一截，而且用户要读完输入框才发现它。

同时删掉 `urlHint` 里的 Nextcloud 示例（`https://…/remote.php/dav/files/<用户名>/`），只留坚果云一条。理由是那条示例带尖括号占位符、长得像一个模板，而这句提示只是告诉人「填到文件夹这一层」，一条例子足够。

### 决策十一、「同步内容」每条一行小字，说清同步的是什么

原来每行只有名字（「模型供应商与模型」「默认模型」…），用户看不出这一份到底包含什么、该不该打开。现在每个 `partRow` 由 `Checkbox` 与它下面一条 `.partHint`（12px、`--dsw-alias-label-tertiary`）组成，右侧的状态文字不变。文案由新的 `PART_HINT: Record<Part, WebdavSyncKey>` 映射到 `partModelsHint` / `partDefaultsHint` / `partPluginsHint` / `partPatchHint`，内容按 `src/store.ts` 的真实切分写，但**只讲用户能判断的东西**（有哪些供应商与模型、默认用哪个、装了哪些插件、还包含哪几类配置），不点名 `cordis.patch.yml` 的行名或 `llm-pi-ai` 之类的标识符——那是实现细节，出现在卡片上只会让人多一个听不懂的名词：

- models：有哪些供应商、各自提供哪些模型、API key 从哪里读。
- defaults：新开会话时默认用哪个供应商、哪个模型。
- plugins：装了哪些插件、按什么顺序加载；**包体不传**，每台机器自己装。
- patch：MCP 服务器、权限预设、界面设置、insert 块等其余配置。

`.partRow` 因此从 `align-items: center` 改成 `flex-start`（左侧是两行），`.partState` 补 `padding-top: 1px` 让状态文字与复选框首行对齐。

## 影响

正面：卡片明显变矮（自动同步一行、同步内容不再每组一个开关、底部没有两行常驻提示，路径区块整块消失）；「这一份同步不同步」与「一不一致」在视觉上分开；按钮只有「主操作实心 / 其余描边」两种形态，不再有点起来才发现是按钮的纯文字按钮；保存这个影响整卡的动作不再和「用本机覆盖服务器」挤在一起；每一份同步内容都自带一行说明，不必去猜；中文用户看到的所有提示（含服务器拒绝、pnpm 失败、口令不对）都是中文。

负面：

- 宿主侧从此没有英文界面。英文用户会看到中文错误消息——这是明确接受的取舍，不是遗漏。
- 将来真要做多语言，得先把宿主文案搬进一套宿主侧字典（`engine.ts` 与 `dav.ts` 的构造点很多，且有些消息带参数），这次没有留下这套机制。
- 卡片不再显示 profile 目录等路径。排查「同步到底动了哪个文件」时，用户得自己去看 `README.md`（或 `DSH_PROFILE_DIR`）。这是「少即是多」换来的代价。
- 「关闭同步」现在藏在下拉框末尾，可发现性下降（见决策九）；它是低频且会清掉本机地址的动作，藏深一点、加上确认框，是刻意换来的安全边际。
- 卡片变高了：四条 `.partHint` 各占一行。这是用户明确要的信息，不打算再压。
- UI 改动没有自动化测试守护，改版式时靠 `pnpm typecheck`（`tsconfig.client.json`）和人工核对。
- `.partState` / `.partStateBoth` 等旧类从「同步内容」的旧形态沿用了下来，第三轮新增 `.partText` / `.partHint` / `.hints`。`WebdavSyncCard.module.css` 里不再引用的 `.toggleLabel` / `.toggleControl` / `.partName` / `.meta` / `.metaKey` / `.metaValue` / `.toggleText` / `.toggleHint` 已删除；`Switch` / `SegmentedControl` 的样式随组件一起消失，`Button` 的 `ghost` 变体在本卡片里也不再引用。`.toggleRow` 现在只包「保存密码」那一个复选框，给它与上面的输入框之间加一条分隔线。以后若再改这一块，先确认类名没有残留引用（只剩一个历史遗留的 `.spin` 是空的）。

## 相关

- `docs/decisions/0008-browser-half-over-routes.md` —— 浏览器半边只走路由，字典覆盖不到宿主消息的根源。
- `docs/decisions/0009-rescheduling-auto-sync-timer.md` —— `autoEvery` 与 `AUTO_CHOICES` 的语义，本轮只换了呈现方式。
- `docs/decisions/0029-status-says-only-what-it-knows.md` —— 「当前是否一致」这句话背后 `localChanged` / `remoteChanged` 的分工。
- `docs/decisions/0007-never-silently-overwrite.md` —— 「用本机覆盖服务器」按钮为什么必须和「保存」分开摆。
