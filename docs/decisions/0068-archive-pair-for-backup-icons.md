# 0068 — 手动备份的两个图标改成同一只箱子的一对

- 状态：已接受
- 日期：2026-10-22
- 相关：[0067](0067-part-order-and-backup-icons.md)（本条改它决策 3 的图标选择：位置、尺寸、`RowAction`、无第二个文字标签都照旧）、[0060](0060-manual-backup.md)（手动备份两行）、[0064](0064-every-prompt-dismissable.md)（同一形状的 24px ghost 图标按钮）

## 背景

0067 把手动备份的导出/导入从文字按钮换成图标：导出用 `IconDownloadOutlineRegular`（下箭头落进托盘），导入用 `IconUnarchiveOutlineRegular`（箱子上一个上箭头）。用户看过之后说（m00487）：

> 导入/导出  要是同类型的，这两个图标不是一类的，需要调整

对着实物核了一遍，确实不是一类：下载图标是三条 1px 描边的开口托盘，箱子图标是一整块 `fillRule="evenodd"` 的实心路径；两件东西的画法、造型语言、视觉重量都不一样，摆在上下两行里像两个不相干的功能，而不是同一件事的两个方向。

## 决策

1. **导出改用 `IconArchiveOutlineRegular`，导入留 `IconUnarchiveOutlineRegular`。两个图标因此是同一只箱子的一对：封着的那只盖子上带一横，拆开的那只盖子上带一个向上的箭头。** 同一套 primitive、同一套画法（同样 16 的 viewBox，只在 Unarchive 上因为是整个箱体轮廓而用 20），一行一只，读起来是「封装 → 拆开」这一件事的两个方向。否决继续用下载图标：它和箱子图标不是一类，正是这次要修的问题；也否决把两只箱子都换成下载/上传：库里根本没有上传图标（`IconUpload*` 在 `lib/types/icons/index.d.ts` 与打包产物里都不存在，`Upload`/`upload` 字符串计数为 0），要自己画一只镜像的上传，而那等于往卡片里塞一段手绘 SVG，和「用库里的图标」这条不成文的约定相抵。
2. **本地的 `LocalUpload` 自绘方案被否决，但保留在验证记录里。** 它把下载托盘的箭头反转、托盘不动作，确实能做出一对同源的「出/入」，造型也干净；否决的理由只有一条 —— 一张卡片为两个按钮各配一段手写 `<path>`，以后 primitive 换版或卡片换主题色时，这两段路径要单独维护，而库里的箱子图标不用。把「用同一只箱子」作为代价更小、同源性更强的解。
3. **只换图标，不碰 0067 定下的其余形状。** `RowAction`、`Tooltip` + `variant="ghost" size="sm"`、`aria-label` 与 tooltip 提供「导出 / 导入」、24px 见方（`.page button.backupIcon`）、SVG 显式 14px、紧接标题 —— 全部沿用；导出的那个 glyph 从下载换成封箱，导入的一直是拆箱。`importHint` 不提图标，无需改。
4. **量过再定。** 用隔离 Chromium 把四个候选按卡片真实规则（24px 按钮、14px SVG）渲染到同一张图上比对：`IconArchiveOutlineRegular` 与 `IconUnarchiveOutlineRegular` 的描边粗细、留白、箱子比例在 14px 下几乎一致；下载图标明显更轻、托盘更薄；`Medium` 变体偏重，与卡片其它图标（Regular）不是一档，未采用。

## 影响

- `src/client/ManualBackupPanel.tsx`：`IconDownloadOutlineRegular` 从 import 里换成 `IconArchiveOutlineRegular`，导出那一行的 `icon` 换成 `<IconArchiveOutlineRegular />`；模块文档与 `RowActionProps.icon` 的注释从「下载 / 拆箱」改成「同一只箱子，封着 / 拆开」。导入行不动。
- 无 CSS 改动：两只 glyph 走同一条 `.page button.backupIcon` 与同一段 SVG 尺寸规则，viewBox 差异由浏览器按 CSS 尺寸缩放，实测都是 24px 见方里居中 14px，行高与说明句不动。
- 三个测试文件里的图标桩从 `IconDownloadOutlineRegular`（`.download-icon`）换成 `IconArchiveOutlineRegular`（`.archive-icon`），断言同步；`<svg>` 计数仍为 6（一个刷新 + 三个复制 + 两个备份），不受影响。
- README 两处（手动备份散文段与动作表「导出」行）的「下载图标」改成「封箱图标」，并说明两个图标是同一只箱子的一对。
- 不改依赖，不改 `package.json` 的版本号；客户端与宿主半边都要重新构建并一起加载。
