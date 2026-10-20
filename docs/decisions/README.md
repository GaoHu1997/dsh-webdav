# 决策记录（Decision Records）

本目录存放本仓库非平凡变更的决策记录（ADR）。每次非平凡变更须在同一个提交里新增或更新一条记录。

## 规范

- 文件名：`NNNN-短标题.md`（四位递增序号，kebab-case 短标题），如 `0001-port-magpie-davsync.md`。
- 状态：`已接受` / `已废弃（被 NNNN 取代）`。
- 结构（必须包含以下小节）：
  - `## 背景` — 变更面对的处境与约束。
  - `## 决策` — 做了什么、为什么选它（含被否决的备选与理由）。
  - `## 影响` — 采纳后带来的后果（正反两面都要写）。
- 语言：中文为主，代码与包名保留原文。

## 索引

- [0001 — 移植 magpie 的 davsync 设计，用分片三方合并](0001-port-magpie-davsync.md) — `已接受`
- [0002 — 备份用口令在本机加密（AES-256-GCM + PBKDF2-SHA256，600000 轮）](0002-passphrase-sealed-backup.md) — `已接受`
- [0003 — 密码与口令存 `.dsh-webdav-sync/sync.json`(0600)，绝不进 `cordis.patch.yml`](0003-secrets-in-state-file.md) — `已接受`
- [0004 — 远端只保留一个加密文件，`node_modules` 不参与同步](0004-single-remote-file.md) — `已接受`
- [0005 — 同步分为 models/defaults/plugins/patch 四份，plugins 份永不删除](0005-four-parts-and-plugin-exception.md) — `已接受`
- [0006 — 冲突时新者胜、败者留档 `sync/`；每次覆盖前先留档](0006-newer-wins-and-keep-aside.md) — `已接受`
- [0007 — 非我方文件与损坏备份的处理：不静默覆盖，重建需本机曾同步过](0007-never-silently-overwrite.md) — `已接受`
- [0008 — 浏览器半边只走 `/plugin/webdav-sync` 路由，口令只以布尔值下发](0008-browser-half-over-routes.md) — `已接受`
- [0009 — 自动同步用可重读配置的定时器（`autoEvery`，默认 `-1`）](0009-rescheduling-auto-sync-timer.md) — `已接受`
- [0010 — pnpm 子进程输出写文件描述符而不是管道](0010-pnpm-output-to-file-descriptor.md) — `已接受`
- [0011 — 状态以 `stateKey` 隔离，`errorKey` 记录失败所针对的配置](0011-state-key-isolation.md) — `已接受`
- [0012 — 地址归一化：`basePath` 记下地址自身的路径，`url()` 不再拼出双斜杠](0012-address-path-and-double-slash.md) — `已接受`
- [0013 — `pendingInstall` 带上缺哪些包，而不只是一个布尔](0013-pending-install-names.md) — `已接受`
- [0014 — 浏览器 bundle 用 `sourcemap: 'hidden'`，不发布指向不存在文件的注释](0014-hidden-sourcemap.md) — `已接受`
- [0015 — 改地址或换账号时，不许把已存的密码带过去](0015-password-not-carried-across-accounts.md) — `已接受`
- [0016 — 找 pnpm 时先查 PATH，让「这台电脑没有 pnpm」说成那句为它写的话](0016-find-pnpm-on-path-first.md) — `已接受`
- [0017 — 无 ETag 盲写后的基线只在服务器真的不同的时候回滚](0017-blind-write-baseline-guard.md) — `已接受`
- [0018 — 写操作排队：sync/restore/upload/undo 一次只跑一个](0018-serialize-writes.md) — `已接受`
- [0019 — 「不记住密码」只管落盘，本次运行仍用内存里的密码](0019-session-password-not-remembered.md) — `已接受`
- [0020 — 手写行没有 `config:` 时按空配置合并，不再抛 TypeError](0020-apply-patch-without-config-key.md) — `已接受`
- [0021 — 传输成功与操作结果各占一个字段：`{ ok, data }` 取代展平](0021-transport-and-result-ok.md) — `已接受`
- [0022 — 解封之后先校验四个分片的形状，坏包按损坏处理](0022-validate-part-shapes.md) — `已接受`
- [0023 — 没有 id 的 `insert:` 块按内容取身份键，不再都叫 `insert:?`](0023-anonymous-insert-keys.md) — `已接受`
- [0024 — 无基线时不拒绝同步，但要把被服务器接管的本机副本说出来](0024-adopting-server-keeps-local.md) — `已接受`
- [0025 — 恢复和撤销都不写配置关掉的分片](0025-restore-undo-respect-disabled-parts.md) — `已接受`
- [0026 — 换密码不换身份，所以密码不进 `stateKey`（否决审查提议）](0026-password-not-in-state-key.md) — `已接受`
- [0027 — 坏掉的文件不等于没有这个文件，读不出来说出是哪个文件](0027-damaged-is-not-missing.md) — `已接受`
- [0028 — 报错时沿着 `cause` 链说话，最多 5 条且去重](0028-say-what-the-chain-says.md) — `已接受`
- [0029 — 状态只回答它真知道的事，`localChanged` 与 `remoteChanged` 各答一侧](0029-status-says-only-what-it-knows.md) — `已接受`
- [0030 — 审查里那六条不改的发现，以及为什么](0030-review-findings-not-changed.md) — `已接受`
- [0031 — 同步卡片按「设置 / 动作」重排，宿主提示统一中文](0031-card-layout-and-chinese-messages.md) — `已接受`
- [0032 — 发版由 tag 驱动：推 `v1.0.0` 就发布 npm 并开出对应的 GitHub Release](0032-tag-driven-release.md) — `已接受`
- [0033 — 「保存密码」移进密码字段的标签行，删掉那句说明](0033-password-checkbox-on-its-field.md) — `已接受`
- [0034 — 额外请求头：一行一条，写在每个请求自带的头之下](0034-extra-request-headers.md) — `已接受`
- [0035 — 备份文件改叫 `.prop`，旧名只读回看](0035-backup-suffix-prop.md) — `已接受`
- [0036 — 第五份「附加目录」：路径跟着配置走，只增不减，恢复写回同一个目录](0036-extra-directories-part.md) — `已接受`
- [0037 — 请求头字段不再带说明，示例改成两行](0037-headers-field-shows-two-lines.md) — `已接受`
- [0038 — 第二轮审查：目录写入的反斜杠绕过、读取上限边收边数、一批零引用导出](0038-review-fixes-second-pass.md) — `已接受`
- [0039 — 卡片把「上次检查」与「上次同步」并排一行，并且自己每隔 15 秒重读一次](0039-the-card-says-check-and-sync-apart.md) — `已接受`
