# 0066 — 仓库只收源码与决策记录，本地产物一律忽略

- 状态：`已接受`
- 日期：2026-10-22
- 相关：[0032](0032-tag-driven-release.md)（tag 驱动发布，`artifacts/` 由工作流生成）、[0014](0014-hidden-sourcemap.md)（构建产物不进仓库）

## 背景

此前 `.gitignore` 由首次提交落地，只覆盖了 `node_modules/`、`lib/`、几个本地 scratch 目录和 `artifacts/`，另有一条指向 `docs/` 的注释（「`docs/decisions/` 之外的 `docs/` 不进仓库」）却没有对应规则，属于悬空注释。实际工作中工作树里反复出现不该提交的东西：

- 构建与测试产物：`dist/`、`coverage/`、`*.tsbuildinfo`；
- 打包探测与验证目录之外的零散文件：根目录的 `*.tgz`（`pnpm pack` 的产物）、`pnpm-debug.log*` 与其他 `*.log`；
- 每台机器自己的环境文件：`.env`、`.env.*`；
- Windows 与编辑器杂物：`Thumbs.db`、`desktop.ini`、`.vscode/`。

这些文件一旦被 `git add .` 带进提交，就会在别人的机器上产生假改动，或把本地密钥写进历史。仓库的定位是「源码 + `docs/decisions/` 决策记录」，其余都可以从源码重建。

## 决策

- 补齐 `.gitignore`：加入 `dist/`、`coverage/`、`Thumbs.db`、`desktop.ini`、`.vscode/`、`*.tgz`、`*.log`、`pnpm-debug.log*`、`.env`、`.env.*`。
- 把那条悬空注释落成真实规则：`docs/*` 加 `!docs/decisions/`。决策记录照旧入库，`docs/` 下其他内容默认不入库。
- 保留既有条目与注释措辞（`lib/`、`.verify/`、`.pkgcheck/`、`.research/`、`.review-scratch/`、`artifacts/` 等），只在尾部追加，不去重排。
- 不把 `lib/` 从忽略里拿掉：构建产物由 `prepublishOnly` 在发布时从源码重建，npm 包的 `files` 字段独立生效，与仓库是否跟踪 `lib/` 无关。

否决的备选：用 `git add -A` 之后再 `git reset` 剔除——靠人工记性，下一次还会漏；把 scratch 目录真的删掉——它们是本地验证的现场，删了下次还得重建；用全局 `core.excludesFile`——规则要跟仓库走，才能对所有人一致。

## 影响

- 正面：`git status` 之后再出现的就是真实改动，`git add -A` 不再有把产物或密钥带进提交的风险。
- 正面：悬空注释与实际规则对上，后来者不必猜「`docs/` 到底收不收」。
- 代价：`*.tgz` 是全局忽略，将来若真要提交某个 tarball 得 `git add -f`；同理 `docs/` 顶层新增文档默认被忽略，需像 `decisions/` 一样显式放行。这两条都在注释里写明了意图。
- 不影响发布：npm 包与 GitHub Release 附件的构建仍由 `.github/workflows/` 从 tag 源码重新生成。
