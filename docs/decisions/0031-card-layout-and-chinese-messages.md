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

第四轮（看到小字与按钮之后）又提了三条：「同步内容的每一条小字…字号还需要调小，现在太大了」；「同步按钮换行了，不美观」；「自动同步的选项换成选项卡，关闭同步、手动同步、3 分钟、15 分钟、30 分钟、1 小时 六个选项卡片，一条展示，选择那个，那个高亮」。

第五轮提了一条：「这些描述都分散到小标题，什么用户名之类的下面，不要聚集，是哪里的就放到哪里」——把第三轮聚到小节标题下的四条说明拆回各自的字段（决策十）。

第七轮提了一条（第六轮见决策十与十四）：把三句「这个功能是干什么的」说明整个删掉——卡片顶部的小节说明（`sectionSubtitle`「把本机的模型配置与已装插件同步到 WebDAV，多台机器保持一致。」）、地址字段下的 `urlHint`（「地址填到文件夹这一层，例如坚果云 https://dav.jianguoyun.com/dav/。」）、「同步内容」标题下的 `partsHint`（「按份合并：只在本机改动的推送出去，只在服务器改动的取回来，两边都改过的保留较新的一份，被替换的那份存到 sync 目录。」）。三条都是**没有动作可做**的复述，见决策十五。

约束：`@deepseek-ai/dsh-client-ui-primitives` **没有下拉组件**（`lib/` 下只有 Button/Input/Checkbox/Switch/SegmentedControl/Tag/Menu 等，没有 Select），所以第二轮的下拉必须自绘，第四轮改回选项卡则是用库里现成的 `SegmentedControl`。宿主侧的错误消息是**直接给人看的**：`src/index.ts` 的路由把 `error.message` 原样放进 400 响应，卡片把它显示成 `state.message`；`locales.ts` 的字典只覆盖浏览器半边，覆盖不到它。

## 决策

### 决策一、自动同步是一排六个选项卡，不是下拉框

第二轮按当时的要求把它改成了原生 `<select>`（自绘 `.select`，照抄 `Input.module.css` 的高度、边框与圆角）。第四轮用户改口要选项卡，于是回到基础库的 `SegmentedControl`——六个选项一条横排、选中的那个由滑块高亮：

```tsx
<SegmentedControl
  id="webdav-sync-auto"
  className={css.autoControl}
  label={t('autoLegend')}
  value={state.url.trim() === '' ? AUTO_OFF : String(state.autoEvery)}
  disabled={busy}
  options={autoOptions(t)}
  onChange={(next) => {
    if (next === AUTO_OFF) props.askOff()
    else props.setAuto(Number(next))
  }}
/>
```

选项由 `autoOptions(t)` 生成，顺序是「关闭同步 / 手动同步 / 3 分钟 / 15 分钟 / 30 分钟 / 1 小时」：`AUTO_CHOICES`（`src/wire.ts:241`，`[AUTO_MANUAL = -1, 3, 15, 30, 60]`）仍是唯一的数值来源，`AUTO_OFF = 'off'` 单独排在前面（见决策九）；`60` 分钟经 `minutes % 60 === 0` 判成整点后走新键 `autoHour`（zh `1 小时`），其余走 `autoEvery`（zh `3 分钟`）。

为了让六个中文标签挤进一行，`.autoControl.autoControl` 用重复类名的写法压过 `SegmentedControl` 自带的 `display: inline-grid`，改成 `display: grid; width: 100%`；`.autoControl button` 把每段的 `padding` 从库默认的 `0 16px` 收到 `0 6px`、字号从 13px 收到 12px。库的 `.control` 本来就是 `grid-auto-flow: column; grid-auto-columns: 1fr`（各段等宽）加 `white-space: nowrap`，所以六段会均分整行宽度，标签短的那个不会缩成一块。

否决了另外三条：(a) 保留第二轮的原生 `<select>`——用户明确要「六个选项卡片，一条展示」，下拉框一次只看得到一个选项；(b) 自己写一排按钮——`SegmentedControl` 已经带了 `role="tablist"`、方向键与 Home/End 走位、`aria-selected`，重写只是把无障碍退回去；(c) 留 `SegmentedControl` 但只放四个选项、把 3 分钟与 15 分钟藏起来——那等于替用户决定哪个间隔值得要。

代价：六段的宽度由最宽标签（「关闭同步」「手动同步」这类四字标签）决定，卡片窄的时候会比下拉框占更多横向空间；这也是第四轮之后 `.partHint` 与按钮间距一起收紧的原因。

### 决策二、同步内容是「复选框 + 后置状态文字」，不是开关

每行改为 `<Checkbox checked={part.synced} label={t(PART_NAME[part.part])} ... />` 后跟一个 `.partState` 状态文字（`partSynced` / `partOnlyHere` / `partOnlyThere` / `partBoth`，关掉时是 `partOff`；`partBoth` 额外加 `.partStateBoth` 走 warning 色）。基础库的 `Checkbox` 渲染的就是 `<label><input type="checkbox">文本</label>`，复选框天生在文本前，正是要的形态。同一轮的「记住密码」也从 `Switch` 换成 `Checkbox`——用户说的是「不使用按钮开关」，留一个开关在同一张卡片里会自相矛盾。`Switch` 因此从 import 里去掉（`SegmentedControl` 第二轮曾一并去掉，第四轮改选项卡后重新引入，见决策一）。

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

「测试连接/预览/立即同步/服务器覆盖本机/撤销恢复/本机覆盖服务器」六个同步动作留在「同步内容」小节末尾的 `.footer` 里（原来还有第七个「关闭同步」，第三轮挪进了自动同步的选项里，见决策九）；「放弃改动/保存」移到整张卡片的最后，装在新类 `.cardFooter` 里（`border-top: 1px solid var(--dsw-alias-border-l2)` 起一条分隔线），左侧加一句 `saveLegend`（zh：`保存以上设置（服务器、自动同步、同步内容）`），顺序是「放弃改动」在左、「保存」在右（主按钮靠右、破坏性动作不贴主按钮）。

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

> **0043 为本节开了一个口子**：「立即同步」不再是 `primary`，改成一个带强调色的文字按钮（`ghost` + `--dsw-alias-state-business-primary` + 悬停底色）——用户嫌实心块丑，但文字按钮又必须看得出可点，于是靠颜色而不是靠框。本节「每张卡片只有一个实心主操作（保存与确认框的「确定」）」与「其余动作一律 `outline`」仍然有效。

否决两种做法：(a) 全卡片只用一种变体——那样「立即同步」和「撤销恢复」看起来同等重要，而后者大多数时候是 disabled 的；(b) 保留 `ghost` 只统一次要按钮——`ghost` 与 `outline` 并排时仍会被读成「有的有框、有的没有」，正是用户看到的那件事。

### 决策九、「关闭同步」是自动同步这一排选项卡的第一个

第二轮先把它做成下拉框的末项，第四轮改成选项卡后位置也换到**最前面**：`autoOptions(t)` 的第一个选项是 `{ value: AUTO_OFF, label: t('autoOff') }`（`AUTO_OFF = 'off'`，与 `AUTO_CHOICES` 里的数字区间不冲突），文案 `autoOff`（zh：`关闭同步`，第二轮带过的省略号去掉了——选项卡里的标签不该留省略号，那是「还会再弹一步」的下拉框写法）。选到它时 `onChange` 不去调 `setAuto`，而是调既有的 `props.askOff()`，走的还是原来那个确认框（`confirmOff`）与 `/off` 路由——语义、清空范围（只清 `url` 与 `password`）、服务器文件保持原样都一字未变，变的只是入口与位置。

位置从末尾换到开头不是为了好看：`SegmentedControl` 的滑块位置由 `--dsh-segment-index` 决定，把「关闭」放末尾，最常用到的「手动同步 / 15 分钟」会被挤到中间偏右，而卡片窄时最先被压的正是末尾几段。放开头之后六个标签里最长的两个（`关闭同步`）挨着左边，右侧留给「1 小时」这种两个字加数字的短标签。

**受控值的坑**：选项卡必须由 `state.autoEvery` 受控，但「关闭同步」不是一个存得住的区间——点它会弹确认框，此时 `autoEvery` 还没变。所以 `value` 写成 `state.url.trim() === '' ? AUTO_OFF : String(state.autoEvery)`：地址被「关闭同步」清空之后，选项卡就落在第一个上；一旦填了地址，它回到真实区间。这样既不会出现「停在 off 这个假值上」，也不会在取消确认后把界面留在错误的档位上。

顺带删掉 `turnOff` 这个字典键（原来只给那个按钮用，现在没有调用者了）。

这么排的理由：「关闭同步」在用户心里就是「不要自动同步了」的一种取值，和「手动同步 / 每 N 分钟」是同一个问题的答案；单独摆一个按钮，等于把同一件事的两种选择拆到两处。选项卡把六个取值一次摊开，可发现性问题也一并解决——这是第二轮「藏在下拉框末尾」那个代价的回收。误点它会清掉本机地址与密码，所以确认框仍在，不会误伤。

### 决策十、说明文字跟着它自己的字段走，不聚成一堆

这一条改过两次，方向正好相反，记下最终形态与两次的理由：

- 第二轮之后，`urlHint` / `passwordHint` / `passphraseHint` 分别跟在各自输入框**后面**，把三组输入框在视觉上切碎了。
- 第三轮改成四句（含 `rememberPasswordHint`）合成一个 `.hints` 无序列表，紧贴小节标题（`<h4 className={css.legend}>`）正下方。
- 第五轮用户要的又变回来：「这些描述都分散到小标题，什么用户名之类的下面，不要聚集，是哪里的就放到哪里」。于是每句回到它自己那个字段里，位置在**该字段的标签之后、输入框之前**，用新的 `.fieldHint`（12px、`--dsw-alias-label-tertiary`、`margin: 0`），`.hints` 随之删除。`rememberPasswordHint` 落在「保存密码」复选框正下方，`.toggleRow` 从 `align-items: center` 改成 `flex-direction: column; align-items: flex-start` 容纳这第二行。

三个字段各自的话：地址那句讲「填到文件夹这一层」并给一个例子；口令那句讲加密与「别和密码用同一个」；复选框那句讲关掉之后密码只活在本次运行里。各条互不相干，放在一起读像是这一节的通则，回到字段里才是各自的注解——这是第五轮要的效果。

第六轮把「密码」那句（`passwordHint`）整个删了：用户指出「密码留空表示沿用已保存的那个。」是废话。密码框在已存过密码时本来就显示 `••••••••` 占位符，留空沿用是所有人对密码框的默认期待，专门写一句反而提示「这里有奇怪行为」。删掉后密码格只剩标签与输入框，`passwordHint` 从 `locales.ts` 的键类型与 zh/en 两份字典里一起移除，行为（留空即沿用）不变。

`urlHint` 里的 Nextcloud 示例（`https://…/remote.php/dav/files/<用户名>/`）在第三轮已删，只留坚果云一条；理由是那条示例带尖括号占位符、长得像一个模板，而这句提示只是告诉人「填到文件夹这一层」，一条例子足够。

### 决策十一、「同步内容」每条一行小字，说清同步的是什么

原来每行只有名字（「模型供应商与模型」「默认模型」…），用户看不出这一份到底包含什么、该不该打开。现在每个 `partRow` 由 `Checkbox` 与它下面一条 `.partHint`（第四轮从 12px 收到 11px，见决策十二；色仍是 `--dsw-alias-label-tertiary`）组成，右侧的状态文字不变。文案由新的 `PART_HINT: Record<Part, WebdavSyncKey>` 映射到 `partModelsHint` / `partDefaultsHint` / `partPluginsHint` / `partPatchHint`，内容按 `src/store.ts` 的真实切分写，但**只讲用户能判断的东西**（有哪些供应商与模型、默认用哪个、装了哪些插件、还包含哪几类配置），不点名 `cordis.patch.yml` 的行名或 `llm-pi-ai` 之类的标识符——那是实现细节，出现在卡片上只会让人多一个听不懂的名词：

- models：有哪些供应商、各自提供哪些模型、API key 从哪里读。
- defaults：新开会话时默认用哪个供应商、哪个模型。
- plugins：装了哪些插件、按什么顺序加载；**包体不传**，每台机器自己装。
- patch：MCP 服务器、权限预设、界面设置、insert 块等其余配置。

`.partRow` 因此从 `align-items: center` 改成 `flex-start`（左侧是两行），`.partState` 补 `padding-top: 1px` 让状态文字与复选框首行对齐。

### 决策十二、同步动作压成一行，`.partHint` 再小一档

第四轮前两条都是「挤不下」：六个同步按钮「换行了，不美观」，每条说明的小字「字号还需要调小」。两处都只动 CSS，不动结构：

- `.footer` 的 `gap` 从 `8px` 收到 `6px`，并去掉「立即同步」与「服务器覆盖本机」之间的 `<span className={css.spacer}/>`——那个 `flex: 1` 的空档把一组按钮硬推成两截，是换行的直接原因。同时 `.footer button { padding: 0 8px }` 把 `Button` 自带的 `0 10px` 收窄（`size="sm"` 的行内 padding 覆盖掉），六个中文标签才落得进一行。`flex-wrap: wrap` 保留：卡片窄到极限时宁可换行，也不要按钮互相重叠或溢出。
- `.partHint` 从 `12px / line-height 1.5` 收到 `11px / 1.4`。它本来就是三级文字（`--dsw-alias-label-tertiary`），比正文小、比注解略大；再压一档之后它与标题拉开的层级更清楚，四条并存时整块也短了一截。没有更小，是因为 10px 在中文里笔画会糊。（这一档之后序号文字仍是 14px，层级反而反了，第六轮才修，见决策十四。）

第三轮担心过「卡片变高了：四条 `.partHint` 各占一行」，这两条改动是同一个问题的另一半答案：字小一档、按钮少占一行，总高度回来一些。README 里「按钮只有两种形态」「每组一个 primary」的规则没有变。

### 决策十三、选项卡里的文案去掉量词与省略号

同一轮把自动同步的标签从「仅手动 / 每 3 分钟 / 关闭同步…」改成「关闭同步 / 手动同步 / 3 分钟 / 15 分钟 / 30 分钟 / 1 小时」：选项卡里每个标签本身就处在一个「选多长时间」的语境中，`每` 字重复六遍只是噪音；整点用新键 `autoHour`（`{n} 小时`）而不是 `60 分钟`，因为人多半按小时想这件事。同步动作的三个标签同步缩短（`服务器覆盖本机` / `撤销恢复` / `本机覆盖服务器`，原文分别是 `用服务器覆盖本机` / `撤销上次恢复` / `用本机覆盖服务器`），省下的正是让它们排进一行的宽度（决策十二）。缩短只删虚词，动作方向（谁覆盖谁）一个都没省——那是这三个按钮唯一要紧的信息。

### 决策十四、复选框文字收到 12px，状态文字收到 11px，梯度与标题一致

前几轮一直没动复选框自己那行字，因为它来自组件：`Checkbox.module.css` 里 `.checkbox { font-size: 14px; line-height: 20px }`，比这一节的小标题（`.legend`，12px/600）和「服务器」里各字段的标签（`.fieldLabel`，12px）都大。于是「同步内容」四条看起来像是整张卡片上最重要的一行，标题反而像它的注解——用户第六轮的原话是「现在都比小标题还大了，不协调」。

修法：`.partRow label` 把复选框那行字压到 `12px / line-height 18px`，方框从 `16px` 收到 `14px`（`.partRow label input`），状态文字 `.partState` 从 12px 收到 11px 并补 `padding-top: 2px`（字变小后行盒变矮，不补就跟第一行错位）。这样整节的字号梯度是：小标题 12px/600 → 每份的名字 12px → 每份的说明与状态 11px，三级由字重与颜色再区分一次。

`.toggleRow label`（「保存密码」）做同样的处理，理由一样：它是字段级的选项，不该比它上面的字段标签大。

为什么用元素选择器而不是 `className`：`Checkbox` 的 `className` 会与组件内部的 `.checkbox` **并列**加到 `<label>` 上，而组件样式表在浏览器里未必先于本卡片的样式表注入——并列规则谁赢看注入顺序，不可靠。`.partRow label` 的优先级（类 + 元素）高于 `.checkbox`（单类），与顺序无关。代价是这条规则依赖「`Checkbox` 渲染的根是 `<label>`」这一实现细节，已在 `node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/Checkbox.module.css` 里核实过；组件哪天改成 `<span><input/>text</span>`，这条规则会静默失效（字变回 14px，但不会坏），届时跟着改一行即可。

### 决策十五、删掉三句「这个功能是什么」的说明

第七轮的三条指向同一类文字：它们讲的是这张卡片**是什么**，而不是用户**能做什么**。

- `sectionSubtitle`（「把本机的模型配置与已装插件同步到 WebDAV，多台机器保持一致。」）：卡片标题「WebDAV 同步」紧挨在它上面，一句话已经说完这是什么；多机一致、加密、按份合并这些内容在 `README.md` 与 0001–0006 几条决策记录里各有一节，卡片上再来一遍只是把第一屏的可操作内容往下推。
- `urlHint`（「地址填到文件夹这一层，例如坚果云 https://dav.jianguoyun.com/dav/。」）：这句只有两个信息，且都已有更好的载体——例子由输入框自己的 `placeholder`（`https://dav.jianguoyun.com/dav/`）承担，看得见又不占行；「填到文件夹这一层」写在 `README.md` 的 `url` 一行里，而地址填得不对时「测试连接」按钮与宿主返回的 404/409 报错会比一句前置说明更直接。
- `partsHint`（「按份合并：…被替换的那份存到 sync 目录。」）：这句是在卡片上复述合并算法（本机改动推送、服务器改动取回、两边都改保留较新、被替换那份进 `sync/`）。它对用户没有可做的动作——合并是同步时自动发生的；真发生替换时，`noticeSaved` 会带出那份副本的**实际路径**，比预先讲一遍规则有用。算法细节的归属同样是 `README.md` 的「合并是怎么做的」一节与决策 0006。

三个键连同 `WebdavSyncKey` 里的三行从 zh 与 en 两份字典一起删掉，`WebdavSyncCard.tsx` 里对应的三行 `<p>` 一并删除（`t()` 少三个调用点）。CSS 不动：`.hint` 仍被「上次同步时间」、`previewEmpty`、`saveLegend` 使用，`.fieldHint` 仍被 `passphraseHint` 使用（`rememberPasswordHint` 后来随 0033 一起删掉）。

这与第六轮删 `passwordHint`（决策十）是同一条判据：**一句话若不改变用户接下来的动作，就不留在卡片上**。据此保留的是——`passphraseHint`（讲加密与「别和密码用同一个」，用户据此决定填什么）、`rememberPasswordHint`（讲关掉后密码不落盘，用户据此决定勾不勾；这一条被 0033 删掉了，理由是位置自己已经说明它管哪个字段）、以及 `PART_HINT` 四条（讲每一份装了什么，用户据此决定这一份要不要打开，决策十一）。

## 影响

正面：卡片明显变矮（自动同步一行、同步内容不再每组一个开关、底部没有两行常驻提示，路径区块整块消失）；「这一份同步不同步」与「一不一致」在视觉上分开；按钮只有「主操作实心 / 其余描边」两种形态，不再有点起来才发现是按钮的纯文字按钮；保存这个影响整卡的动作不再和「本机覆盖服务器」挤在一起；每一份同步内容都自带一行说明，不必去猜；中文用户看到的所有提示（含服务器拒绝、pnpm 失败、口令不对）都是中文。第四轮之后：自动同步六个取值一次摊开、不用点开才知道有哪几档；同步动作收进一行，不再出现「三个按钮一行、三个按钮一行」的断口。第七轮之后，卡片开头与小节标题下不再有复述功能的句子：从上到下第一件东西就是要填的字段，删掉的三句（`sectionSubtitle` / `urlHint` / `partsHint`）在有界面之前先读一遍卡片时确实亲切，但第二次打开就只是挡在动作前面。

负面：

- 宿主侧从此没有英文界面。英文用户会看到中文错误消息——这是明确接受的取舍，不是遗漏。
- 将来真要做多语言，得先把宿主文案搬进一套宿主侧字典（`engine.ts` 与 `dav.ts` 的构造点很多，且有些消息带参数），这次没有留下这套机制。
- 卡片不再显示 profile 目录等路径。排查「同步到底动了哪个文件」时，用户得自己去看 `README.md`（或 `DSH_PROFILE_DIR`）。这是「少即是多」换来的代价。
- 六段选项卡等宽，宽度由最宽标签决定；卡片很窄时它会比下拉框占更多横向空间，`.partHint` 收到 11px、按钮 padding 收到 8px 有一部分就是为它腾地方（决策一、十二）。
- 「关闭同步」混在自动同步的取值里，与「手动同步」并列，语义上它是「不再有自动同步」而不是「间隔为 0」；靠 `confirmOff` 确认框与 `value` 里的空地址判断兜住，但它确实不是一个普通的区间值（决策九）。
- 卡片变高了：四条 `.partHint` 各占一行。这是用户明确要的信息，不打算再压，只把字号收了一档。
- 复选框那行字的字号不归本卡片所有：压它靠的是 `.partRow label` / `.labelRow label`（0033 之前叫 `.toggleRow label`）这类元素选择器，绕开了组件的 `className`（原因见决策十四）。组件换根元素时会静默退回 14px，需要在视觉上重新确认。
- 「服务器」小节比第三轮高：四条说明不再挤成一个列表，而是各归到自己的字段里，`.field` 的 `gap` 因此多出一行的高度。换来的是「哪句话在讲哪个框」不用再对照（决策十）。
- 卡片上不再有「地址要填到文件夹这一层」这句话，也不再有一句合并规则的说明。想知道地址该填到什么粒度、同步会怎么合，只能在 `README.md`（`url` 一行、「合并是怎么做的」一节）里看。这是把界面说明收回文档的代价，判据与决策三删掉 profile 路径时一致：**卡片上留的是能据此做动作的信息，查资料性质的内容归 README**。
- UI 改动没有自动化测试守护，改版式时靠 `pnpm typecheck`（`tsconfig.client.json`）和人工核对。
- `.partState` / `.partStateBoth` 等旧类从「同步内容」的旧形态沿用了下来，第三轮新增 `.partText` / `.partHint`，第五轮新增 `.fieldHint` 并删掉 `.hints`、第四轮新增 `.autoControl`、删掉 `.select`。`WebdavSyncCard.module.css` 里不再引用的 `.toggleLabel` / `.toggleControl` / `.partName` / `.meta` / `.metaKey` / `.metaValue` / `.toggleText` / `.toggleHint` 已删除；`Button` 的 `ghost` 变体在本卡片里也不再引用。`.toggleRow` 到第七轮为止是一列（上面「保存密码」复选框，下面它自己那句说明），0033 把复选框移进密码字段的标签行后它改名 `.labelRow`、那行说明已删。以后若再改这一块，先确认类名没有残留引用（只剩一个历史遗留的 `.spin` 是空的）。

## 相关

- `docs/decisions/0008-browser-half-over-routes.md` —— 浏览器半边只走路由，字典覆盖不到宿主消息的根源。
- `docs/decisions/0009-rescheduling-auto-sync-timer.md` —— `autoEvery` 与 `AUTO_CHOICES` 的语义，本轮只换了呈现方式。
- `docs/decisions/0029-status-says-only-what-it-knows.md` —— 「当前是否一致」这句话背后 `localChanged` / `remoteChanged` 的分工。
- `docs/decisions/0007-never-silently-overwrite.md` —— 「本机覆盖服务器」按钮为什么必须和「保存」分开摆。
- `docs/decisions/0033-password-checkbox-on-its-field.md` —— 第七轮之后，「保存密码」从独立一行移进密码字段的标签行，决策十五里保留的 `rememberPasswordHint` 随之删掉（位置本身就说明它管哪个字段）。
