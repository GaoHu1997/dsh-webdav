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
- `NPM_TOKEN` 是长期 token，要人工轮换；它是否仍然有效，只有发版失败时才知道 —— 仓库里的 secret 读不出来（细粒度 PAT 没有 Actions secrets 读权限），本机也无从预检。
- **token 必须能绕过 2FA，而 `whoami` 查不出这一条。** 首次发版就撞上了：token 有效（`Authenticated on npm as: gaohu9712`）却发布被拒 —— `[E403] 403 Forbidden - PUT https://registry.npmjs.org/dsh-webdav-sync - Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.`。预检只能证明「凭据是真的」，证明不了「能发布」，这一条要真发一次才知道。granular token 须选 Read and write 并勾上 Bypass 2FA（或改用 Classic 的 Automation token）。
- **重跑一个失败的发布：删掉远端 tag 再推一次。** 工作流只认 tag，而本机的细粒度 PAT 没有 `actions: write`，`gh run rerun` 会被拒（`Resource not accessible by personal access token`）。tag 与 `package.json` 的相等校验加上「拒绝重复发布」的检查，让这条路可以安全重跑。
- pnpm 每次发布都会尝试 OIDC 并因权限不足跳过（日志里一行 `[WARN] Skipped OIDC: ERR_PNPM_ID_TOKEN_GITHUB_WORKFLOW_INCORRECT_PERMISSIONS`），因为 `permissions` 里没有 `id-token: write`。改用 npm 的 trusted publishing 是将来免去长期 token 的路，但要先在 npm 上为这个包配置，首次发布仍绕不开一个能发布的 token。
- `release.yml` 把 `ci.yml` 的验证步骤又写了一遍。重复是有意的（发布不必等 CI，也不能依赖另一个工作流的结果），代价是两处要一起改。
- 发布必须等 `test` 跑完（含约 4 秒的测试与构建），发版不是「立刻」的。

## 验证

- 首次发版前：仓库没有任何 tag（`git tag` 为空）；npm 上没有这个包（`npm view dsh-webdav-sync versions --registry https://registry.npmjs.org/` 返回 404，发布之后 `time.created` 正是首次发布那一刻，可见名字此前确实空着）。
- **第一次**推 `v1.0.0`（run 39203992648）在「Publish to npm」失败，前面每一步都通过（匹配 tag、拒绝重复发布、typecheck、208 例测试、构建、打 tarball），并且按设计**没有**创建 Release —— npm 上也就什么都没有留下。失败原因是 token 无权发布，原文见下面「影响」里那条 E403。
- 换掉 `NPM_TOKEN`（granular token，勾上 Bypass 2FA）后重推同一个 tag，run 39205342670 成功，日志逐条对上：`Releasing dsh-webdav-sync@1.0.0 under dist-tag latest`、`NPM_TOKEN: length=40 prefix=npm_(masked)`、`Authenticated on npm as: gaohu9712`、`Release https://github.com/GaoHu1997/dsh-webdav/releases/tag/v1.0.0`。
- 结果：`npm view dsh-webdav-sync version dist-tags` → `1.0.0` 与 `{ latest: '1.0.0' }`；`gh release view v1.0.0` → `draft: false`、附件 `dsh-webdav-sync-1.0.0.tgz`。同一次推送触发的 CI（run 39203969172）也通过。
- 第二个版本 `v1.0.1`（补丁版：同步卡片删掉三句功能复述、「保存密码」移进密码字段的标签行）一次推送就成了，没有重跑：run 39236693936 的十三个步骤全绿（含「Publish to npm」与「Create GitHub Release」），从触发到结束约一分钟。结果：`npm view dsh-webdav-sync version dist-tags` → `1.0.1` 与 `{ latest: '1.0.1' }`；GitHub Release `v1.0.1` → `draft: false`、附件 `dsh-webdav-sync-1.0.1.tgz`。同一次发布前推送 `main` 触发的 CI（run 39235729929）也通过。
- 顺带一条环境观察（与流程无关，但推 tag 时会撞上）：本机到 `github.com:443` 时通时不通，`api.github.com:443` 一直通，`git push` 报 `Failed to connect to github.com port 443 after ~21s`。此时可以钉一个可达的边缘 IP 把推送做完：`git -c http.curloptResolve=github.com:443:140.82.113.3 push origin v1.0.1`（tag 对象本身由本地推上去，远端与本地是同一个，`025132b`）。不要指望用 API 建 tag 绕开：细粒度 PAT 没有这个权限，`POST /repos/{owner}/{repo}/git/tags` 回 403 `Resource not accessible by personal access token`。
- 顺带一条观察：`npm view dsh-webdav-sync versions` 会列出 `['0.0.0-stage', '1.0.0']`。`0.0.0-stage` 与 `time.created` 同刻，不是我们发布的版本，而是注册表在首次发布时留下的占位项；`latest` 指向 `1.0.0`。
- 第三个版本 `v1.0.2`（本机转发器的文件映射：不给 `.zip`/`.prop` 后缀的资源补 `.prop`、别名落盘、PROPFIND 还原客户端名字）同样先推 `main` 再推 tag，两步都成：`main` 的 `7303ea7` 触发 CI（run 39446463700）通过 —— 这一步值得单独做，因为此前 14 个转发提交一直没推上去，转发用例是第一次在 Linux 上跑；tag `v1.0.2` 打在同一个 `7303ea7` 上（标注 tag 对象 `f883283`），release 工作流 run 39448521809 全绿，GitHub Release `v1.0.2` → `draft: false`、附件 `dsh-webdav-sync-1.0.2.tgz`，npm `dsh-webdav-sync` → `1.0.2`、`{ latest: '1.0.2' }`。
- **新踩到的一条：npm 的读数会滞后几分钟，别据此判定发布失败。** 「Publish to npm」在 15:28:26 打出 `✅ Published package dsh-webdav-sync@1.0.2`，但随后直接查 `registry.npmjs.org`，`/dsh-webdav-sync/1.0.2` 仍回 404、`dist-tags.latest` 仍是 `1.0.1`；直到 `time['1.0.2']` 记的 15:31:35 才出现在 packument 里 —— 也就是 pnpm 报成功之后约三分钟。那一步是真成功的（Release 也因此建了出来），核对时若立刻看到旧版本，过几分钟再查一次，不要急着删 tag 重推。
- 另一条关于读数的：本机 npm 的默认 registry 由用户与仓库两个 `.npmrc` 一起钉在 `registry.npmmirror.com`，所以 `npm view dsh-webdav-sync version` 走的是镜像（本次它一开始也停在 `1.0.1`）。核对发布结果要显式加 `--registry https://registry.npmjs.org/`，或直接读 `registry.npmjs.org` 的 packument。
- 第四个版本 `v1.0.4`（去掉 `defaults` 一份、附加目录默认不勾、新增 `keys` 一份、卡片复选框读草稿）同样先推 `main` 再推 tag，一步没重跑：`main` 的 `3c7fb46` 触发 CI（run 39547395996）成功，tag `v1.0.4` 打在同一个提交上，release 工作流 run 39547408603 的十四个步骤全绿（54 秒），GitHub Release `v1.0.4` → `draft: false`、附件 `dsh-webdav-sync-1.0.4.tgz`（138969 字节），npm → `1.0.4`、`{ latest: '1.0.4' }`。这次 `github.com:443` 是通的，没有动边缘 IP。
- 上一条的滞后在 `v1.0.4` 上又量到一次，量级相同：「Publish to npm」与「Create GitHub Release」在 05:04:19 前后完成，05:04:46 直接查 `registry.npmjs.org` 仍是 `{ latest: '1.0.3' }`、`/dsh-webdav-sync/1.0.4` 回 404，到 05:06:5x 再查就已是 `{ latest: '1.0.4' }`。**Release 已经建出来这件事本身就是「npm 那步成功了」的旁证**——工作流里 `Create GitHub Release` 排在 `Publish to npm` 之后，所以先看 Release，再看 npm。
- 顺带一条：`gh release create --generate-notes` 在这个仓库里只生成一行 `**Full Changelog**`（没有 PR，提交也没写可被识别的格式），四个版本的 Release 正文都是这一行。给人看的版本说明写在标注 tag 的消息里（`git show v1.0.2`、`v1.0.3`、`v1.0.4` 都能读到），Release 正文没有另写。
- **发完之后改不了 Release 正文：本地这把细粒度 PAT 没有 Releases 写权限。** 想给 `v1.0.4` 补一段手写说明时，`gh release edit v1.0.4 --notes-file …` 回 `HTTP 403: Resource not accessible by personal access token`（同一个 token 推 `main`、推 tag 都正常，缺的只是 Releases 这一项）。所以版本说明只能落在标注 tag 的消息里，或者下次发版前给 token 补上 Releases 写权限、在 `Create GitHub Release` 那步把手写正文一起传上去。不要指望发完再补。
- 推 tag 这次又撞上 `github.com:443` 不通（`Failed to connect … after 21246 ms` / `Recv failure: Connection was aborted`），而 `api.github.com:443` 与几个边缘 IP 都通。上一次用的 `140.82.113.3` 这次连不上，换 `140.82.114.3` 一次推成：`git -c http.version=HTTP/1.1 -c http.curloptResolve=github.com:443:140.82.114.3 push origin v1.0.2`。边缘 IP 会变，逐个试比反复重试同一个更省时间。
