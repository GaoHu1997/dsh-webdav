# 0032 — 发版由 tag 驱动：推 `v1.0.0` 就发布 npm 并开出对应的 GitHub Release

- 状态：已接受
- 日期：2026-10-19（首次发版 v1.0.0 时补记；`.github/workflows/release.yml` 本身随首次提交落地）

## 背景

仓库从 `dsh-webdav-sync` 0.1.0 起步，包名与 `dsh-model-think-level` 同期，都是 dsh 的第三方插件。首次提交时就带上了两个工作流：`ci.yml` 只管验证（`pnpm run typecheck`、`pnpm test`、`pnpm run build:all`，再把 `lib/` 作为工件传上去），发版的事全部在 `release.yml` 里。`lib/` 是 gitignore 的构建产物，所以发布必须现场构建。

手工发版的常见失败模式，正是这套流程要挡掉的：

- npm 上发布的版本号和 git tag 不是同一个（tag 打错、或忘了先升号）。
- `pnpm publish` 从某个人的笔记本上跑，产物取决于那台机器的状态；本机还未必有 npm 凭据。
- 忘了开 GitHub Release，或者 Release 先于 npm 出现 —— 后者会让「Release 里有、npm 上装不到」成为可能。
- 预发布版本（`1.1.0-rc.1`）被发到 `latest`，于是所有 `pnpm add` 都拿到一个 rc。
- 一个已经在 npm 上的版本被重新发布。

## 决策

发布只由一件事触发：推一个 `v*` tag。其余规矩都从这一条长出来。

- **tag 必须与 `package.json` 的 `version` 严格相等**（比对 `v${version}`，不等就 `exit 1`）。版本号只有 `package.json` 一处来源，tag 只是它的写法；两者不一致时，最坏的结果是把错的版本号发到 npm 上，所以宁可在这里失败。
- **升号是独立的手工 `chore` 提交**（AGENTS.md 的规定），CI 不改版本号。于是 tag 是唯一触发点，而不是「CI 判断该发什么版本」。
- **预发布走 `next`，正式版走 `latest`。** `x.y.z-*` 判为预发布，`pnpm publish --tag next`；否则 `--tag latest`。npm 的 `latest` 是所有裸安装解析到的那一个，误指过去的代价太大。
- **已经在 npm 上的版本直接拒绝**（`npm view <name>@<version> version` 有输出就报错），而不是让 publish 返回一个难懂的 409。
- **凭据只从仓库 secret `NPM_TOKEN` 读**，写进一次性 `NPM_CONFIG_USERCONFIG`，不动被跟踪的 `.npmrc`（它钉着 `@deepseek-ai` 的镜像）。发布前先用 `pnpm whoami` 验证它：npm 对未授权的 PUT 回的是不透明的 404，先验证才能把「token 是坏的/过期的/只读的」说清楚；token 长度不足 30 时另给一条 warning，因为粘贴截断是 401 最常见的原因。
- **GitHub Release 在 npm 接受之后才建**（`gh release create --verify-tag --generate-notes`，附 `pnpm pack` 出的 tarball；已存在则 `gh release upload --clobber`）。顺序是刻意的：Release 不能宣传一个 npm 上没有的版本。工作流最后打印 Release 的 URL、是否草稿与附件清单 —— 草稿对外不可见，所以草稿要告警，发布仍是人的动作。
- **验证在发布前单独跑一遍**（`typecheck` / `test` / `build:all`），尽管 `prepublishOnly` 会重复它：日志里一个具名的失败步骤比「发布死在生命周期脚本里」好读。

被否决的备选：

- **本机 `npm publish`。** 凭据就要落在开发者的机器上，产物取决于本机状态，也发不出「先验证、后发布、最后开 Release」的顺序保证。
- **CI 在 `main` 上自动升版本、打 tag、发布。** 把「发哪个版本」变成 CI 的决定，且与 AGENTS.md「升号由用户发起、且作独立 chore 提交」直接冲突。
- **`workflow_dispatch` 手动填版本号发布。** 多一个与 `package.json` 争谁说了算的来源；tag 已经是那个来源，而且 tag 天然留下「这一刻发布了什么」的记录。
- **发布与建 Release 分成两个工作流。** 会让「npm 拒绝了但 Release 已经开出来」成为可能。
- **`--provenance`（npm 出处证明）。** 需要额外的 OIDC 配置与权限，当前用不上；真要加，也应作为独立变更记录。
- **让 CI 在 `main` 上比对 `package.json` 与已发布版本、不一致就自动发。** 同第二条，且把发版变成一件隐式发生的事。

## 影响

正面：

- 一次 `git push origin v1.0.0` 就完成三件事：npm 上的包、GitHub Release、Release 附件里的 tarball；三者的版本必然一致，因为都读同一份 `package.json`。
- 发布环境可复现：`--frozen-lockfile`、Node 22、pnpm 由 `packageManager` 字段决定（`pnpm/action-setup` 不接受 `version` 输入，传了是错的）。
- 凭据不进仓库、不进被跟踪的 `.npmrc`，工作流日志里也只有长度与前缀。

负面与代价：

- **tag 是唯一入口，也是一次性的**：误推一个 tag 之后，npm 上那个版本只能 `npm unpublish` 或再发一个新版本；Release 同理。
- `NPM_TOKEN` 是长期 automation token，要人工轮换；它是否仍然有效，只有发版失败时才知道 —— 仓库里的 secret 读不出来（细粒度 PAT 没有 Actions secrets 读权限），本机也无从预检。
- `release.yml` 把 `ci.yml` 的验证步骤又写了一遍。重复是有意的（发布不必等 CI，也不能依赖另一个工作流的结果），代价是两处要一起改。
- 发布必须等 `test` 跑完（含约 4 秒的测试与构建），发版不是「立刻」的。

## 验证

- 首次发版前：仓库没有任何 tag（`git tag` 为空），npm 上没有这个包（`npm view dsh-webdav-sync versions --registry https://registry.npmjs.org/` 返回 404）。
- 推 `v1.0.0` 后由 Release 工作流完成发布，日志里应能看到：`Releasing dsh-webdav-sync@1.0.0 under dist-tag latest`、`NPM_TOKEN: length=… prefix=…(masked)`、`Authenticated on npm as: …`、`pnpm publish --access public --no-git-checks --tag latest`，最后是 Release 的 URL 与附件清单（`dsh-webdav-sync-1.0.0.tgz`）。
- 之后可用 `npm view dsh-webdav-sync@1.0.0 version --registry https://registry.npmjs.org/` 与 `gh release view v1.0.0` 各查一次。
