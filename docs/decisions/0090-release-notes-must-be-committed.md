# 0090 — 发布正文随仓库提交，发布前校验

状态：已接受

## 背景

插件市场的「版本更新」弹窗直接渲染 GitHub Release 的 body（`dshmarket/lib/changelog.js` 的 `updateNotesFor` 优先取 release body，其次最近 5 条 commit，最后只给 npm 发布时间）。本仓库直推 main、不走 PR，`gh release create --generate-notes` 只能产出一行 compare 链接：v1.3.3 的正文实际就是这一行，用户点开更新说明看不到任何内容。本仓库也没有 `CHANGELOG.md` 可以补位。

## 决策

- 每个 `vX.Y.Z` tag 必须提交 `.github/releases/vX.Y.Z.md`，文件名与 tag 完全一致。
- `release.yml` 在 `Refuse to republish an existing version` 之后、`Publish to npm` 之前新增 `Verify release notes`：文件存在、≥300 字节、≥8 个非空行、至少一个 `## ` 小节、含 `**Full Changelog**`，任一不满足即 `::error::` 退出。
- 创建 Release 一律 `--notes-file`；已存在时用 `gh release edit` 覆盖正文，不留 `--generate-notes` 兜底分支。
- 已发布版本的正文补写走 `sync-release-notes.yml`（`workflow_dispatch`），不重新发版、不动 tag 与 npm 版本。
- `.gitignore` 不得忽略 `.github/releases/`（当前 `.gitignore` 已用 `!docs/decisions/` 保住决策记录，同一份目录白名单思路适用于正文）。

## 影响

正文缺失的 tag 会在 npm 发布前失败——补好文件重推 tag 即可。v1.3.3 起每个版本的说明都以 `.github/releases/` 为唯一来源，仓库不再维护第二份 CHANGELOG：决策编号写进正文，实现细节写进 ADR，两者不重复。
