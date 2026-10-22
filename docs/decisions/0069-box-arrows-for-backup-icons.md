# 0069 — 手动备份的两个图标改成同一只箱子里的一对箭头

- 状态：已接受
- 日期：2026-10-22
- 相关：[0068](0068-archive-pair-for-backup-icons.md)（本条改它决策 1 的图标选择：位置、尺寸、`RowAction`、无第二个文字标签、「同一只箱子」这条同源原则都照旧）、[0067](0067-part-order-and-backup-icons.md)（行形状与图标位置的来源）、[0060](0060-manual-backup.md)（手动备份两行）

## 背景

0068 把导出/导入换成同一套 primitive 里的两只箱子：导出 `IconArchiveOutlineRegular`（封着的箱子，盖子上带一横），导入 `IconUnarchiveOutlineRegular`（拆开的箱子，盖子上带一个向上的箭头）。用户看过之后说（m00811）：

> 导入应该是箱子里面箭头时向下的，导出里面是箱子里面一个箭头向上的。调整以一下

也就是说，用户要的不是「封箱 / 拆箱」这对状态，而是「同一只箱子 + 一个方向相反的箭头」这对动作：导出是箱子里的东西往外走（箭头朝上），导入是东西往箱子里进（箭头朝下）。0068 的两只箱子恰好把这个方向信息压在了「开/关」上，而且拆箱那只的箭头朝上 —— 与「导入」想表达的方向正好相反，读起来是别扭的。

对着库里 86 个 icon 核了一遍：**没有任何一个图标是「箱子里一个向下的箭头」。** Regular 里属于箱子/托盘一族的只有 `IconDownloadOutlineRegular`（托盘 + 下箭头，不是箱子）、`IconArchiveOutlineRegular`、`IconUnarchiveOutlineRegular`、`IconArchiveCheckOutlineRegular`、`IconArchiveOffOutlineRegular`；artwork 组件（`Icon*Artwork`）是内部实现，`.d.ts` 里 `export declare const Icon\w+Artwork` 计数为 0，无法直接引用。所以要同时满足「箱子」和「箭头朝下」，只能自己画那一个箭头。

## 决策

1. **新建 `src/client/BackupGlyph.tsx`，把这对图标画成同一只箱子的两个方向。** `BackupGlyph({ direction: 'out' | 'in' })` 输出一个 14×14、`viewBox="0 0 16 16"`、`fill="none"`、`strokeWidth={1}` 的 `<svg>`，里面三条 1px `currentColor` 描边路径：库里的箱盖 `LID`、库里的箱体 `BODY`，以及按方向二选一的箭头 —— `ARROW_OUT = 'M8 11.28V8.08M6.28 9.64L8 7.92L9.72 9.64'`（朝上，导出）和 `ARROW_IN = 'M8 7.92V11.28M6.28 9.56L8 11.28L9.72 9.56'`（朝下，导入），两者关于 y=9.6 镜像、杆长 3.2，圆头圆角与库里 `Unarchive` 的箭头同一种画法。箱盖与箱体逐字取自 `IconArchiveOutlineArtwork`，所以这对图标仍然属于卡片其它图标的同一族，只有箭头换了方向。
2. **否决「继续只用库里的图标」。** 库里有箱子、有托盘、有朝上的箭头，唯独没有「箱子 + 朝下箭头」；用 `IconArchiveOutlineRegular` + `IconUnarchiveOutlineRegular` 只能表达「封 / 开」，表达不了用户要的方向，0068 已经证明这个读法不合用户意。也否决把导入改回下载图标或倒过来的托盘 —— 那又回到「两个不相干的图形」的老问题（m00487）。手绘的代价被压到最小：只有一段箭头路径是新写的，箱子是库里的原样。
3. **只换图标，不碰 0067/0068 定下的其余形状。** `RowAction`、`Tooltip` + `variant="ghost" size="sm"`、`aria-label` 与 tooltip 提供「导出 / 导入」、24px 见方（`.page button.backupIcon`）、SVG 显式 14px、紧跟标题 —— 全部沿用。`importHint` / `exportHint` 不提图标，无需改。文案仍不改：模板里的 `exportHint` 早已是「点标题旁的图标」。
4. **量过再定。** 用隔离 Chromium 按卡片真实规则（24px 按钮、14px SVG）把 `BackupGlyph` 的两个方向与库里四只箱子/托盘渲染到同一张图上比对：两只 `BackupGlyph` 与库里箱子在 14px 下的描边粗细、留白、箱子比例一致，两只之间只有箭头方向不同，一对读作一件事的两个方向。

## 影响

- 新增 `src/client/BackupGlyph.tsx`（约 40 行，含模块文档与两条路径常量的注释）—— 这是本仓库第一段手写 SVG，注释里写明为什么不能只用库里的图标。
- `src/client/ManualBackupPanel.tsx`：import 里去掉 `IconArchiveOutlineRegular` 与 `IconUnarchiveOutlineRegular`，改 `import { BackupGlyph } from './BackupGlyph.tsx'`；导出行的 `icon` 换成 `<BackupGlyph direction="out" />`，导入行换成 `<BackupGlyph direction="in" />`；模块文档与 `RowActionProps.icon` 的注释从「同一只箱子，封着 / 拆开」改成「同一只箱子，箭头出去 / 箭头进来」。
- 无 CSS 改动：`BackupGlyph` 的 `<svg>` 走同一条 `.page button.backupIcon` 与同一段 SVG 尺寸规则（14px），24px 见方里居中，行高与说明句不动。
- 三个测试文件：`tests/manual-backup-panel.spec.tsx` 去掉两只箱子的图标桩，改为断言导出行含 `ARROW_OUT` 而不含 `ARROW_IN`（导入行反之）、两行都含库里的箱盖前缀 `M13.5 2.5H2.5C1.94772`、glyph 就是按钮的全部内容；`tests/part-rows.spec.tsx` 与 `tests/settings-layout.spec.tsx` 的 mock 里删掉不再使用的两只箱子图标。`<svg>` 计数仍为 6（一个刷新 + 三个复制 + 两个备份），因为 `BackupGlyph` 在测试里渲染的是真的 `<svg>`。
- README 两处（手动备份散文段与动作表两行）的「封箱图标 / 拆箱图标」改成「箱子加向上箭头的图标 / 箱子加向下箭头的图标」，并说明两个图标只有箭头方向不同。0068 的索引条目注明图标选择被本条调整。
- 不改依赖，不改 `package.json` 的版本号（版本升号是独立提交）；客户端与宿主半边都要重新构建并一起加载。
