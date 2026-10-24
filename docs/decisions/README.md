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
- [0005 — 同步分为 models/defaults/plugins/patch 四份，plugins 份永不删除](0005-four-parts-and-plugin-exception.md) — `已接受`；`defaults` 一份被 0056 去掉，模型目录与 plugins 的例外规则仍有效
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
- [0027 — 坏掉的文件不等于没有这个文件，读不出来说出是哪个文件](0027-damaged-is-not-missing.md) — `已接受`；`sync-state.json` 的部分被 0073 取代（移开重置），`sync.json` 与缓存副本不变
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
- [0040 — 本机转发：只绑回环、路径里带 token，把账号与额外请求头借给别的 WebDAV 客户端；与同步彻底分开](0040-local-relay-for-other-clients.md) — `已废弃（被 0041 取代）`，原文保留为历史
- [0041 — 本机转发复用同步配置：一个开关、同一个保存、本地 Basic 账号](0041-relay-reuses-sync-config.md) — `已接受`；取代 0040 的独立配置文件、路由、保存与路径 token 授权决策
- [0042 — 转发区只给一个地址框：去掉整段说明、复选框与标题同字号、端口收进地址](0042-relay-section-one-address-box.md) — `已接受`；第三节「地址是一个只读文本框」被 0043 取代，第四节「账号不给复制按钮」被 0045 取代
- [0043 — 转发地址排成纯文本加一个复制图标，「立即同步」改成带强调色的文字按钮](0043-relay-address-text-and-sync-text-button.md) — `已接受`；取代 0042 的只读文本框与描边复制按钮，并松开 0031 对 ghost 的禁令；复制失败那句「请手动选中复制」被 0067 改成「请再点一次」（密码改为脱敏显示后已无法选中）
- [0044 — PROPFIND 基目录时补上规范尾斜杠](0044-relay-propfind-collection-slash.md) — `已接受`
- [0045 — 转发的三个值各带一个复制图标，图标紧贴它复制的值](0045-relay-value-copy-icons.md) — `已接受`；取代 0042 第四节「账号不给复制按钮」，并调整 0043 的图标位置与标签
- [0046 — 转发文件资源统一补 `.prop` 扩展名并透传额外请求头](0046-relay-backup-file-extension.md) — `已废弃（被 0050 取代）`；`.prop` 补名及请求头规则仍有效
- [0047 — 转发区的三个值都写名称，账号的值不再套框](0047-relay-labels-and-no-value-frames.md) — `已接受`；接续 0045，给地址补上「地址」名称并去掉账号两个值的框
- [0048 — 六个同步动作全部改成不带框的文字按钮，颜色按「会动谁」分三档](0048-sync-actions-are-text-buttons.md) — `已接受`；把 0043 只给「立即同步」开的文字按钮口径推广到整行，取代 0031 决策八里关于同步动作的 `outline` 规定
- [0049 — 集合 PROPFIND 不改名，MOVE/COPY 目标同步转发映射](0049-relay-collection-and-destination-mapping.md) — `已接受`；省略 Depth 按集合处理，歧义的 Depth 0 无扩展名路径保持原样
- [0050 — 持久化转发文件别名并在 PROPFIND 中还原 href](0050-relay-propfind-aliases.md) — `已接受`；取代 0046「不改写 WebDAV 响应 XML」的决定
- [0051 — 转发用例给真实的回环往返留出超时余量：vitest 超时提到 20 秒](0051-relay-tests-timeout-margin.md) — `已接受`
- [0052 — 转发优先使用显式配置的 User-Agent，避免客户端默认 UA 触发 403](0052-relay-configured-user-agent.md) — `已接受`；为 0041 的客户端头优先规则增加仅限 `User-Agent` 的例外
- [0053 — 「同步内容」的复选框改看草稿，未保存时那一行写「待保存」](0053-part-rows-read-the-draft.md) — `已接受`；调整 0031 决策二的绑定源（复选框与状态文字都读草稿），首次为这几行补上渲染测试
- [0054 — 新增第六份「API 密钥」：名字从配置里读、只发托管存储里的值、只写不删](0054-sync-api-keys.md) — `已接受`；补上 0005/0036 之后一直缺的那一份，密钥有自己的开关，冲突时本机赢
- [0055 — 安装报告自己带一个「关闭」，不再只能靠「放弃改动」消失](0055-closable-install-report.md) — `已接受`；调整 0013 的安装提示流程，并给报告一个只属于它自己的成功/失败标记
- [0056 — 默认模型不再是一份，「附加目录」默认不勾](0056-drop-default-model-part.md) — `已接受`；去掉 0005 定的 `defaults` 一份（`agent-default-model` 行从此不进任何一份），并把 0036 的 `dirsEnabled` 默认值翻成关
- [0057 — 自动同步复用实时凭据，密钥读取失败不推进密钥基线](0057-auto-sync-uses-live-credentials.md) — `已接受`；修复定时器遗漏托管密钥服务与会话密码，沿用 0039 的两个时间语义
- [0058 — v1.0.5 按用户要求不重跑测试发布](0058-v1-0-5-release-without-tests.md) — `已接受`；仅本次发布跳过 CI、tag 与发布生命周期测试，后续版本照常
- [0059 — 状态轮询可恢复，旧时间不再静默保留](0059-recoverable-status-polling.md) — `已接受`；补充 0039 的超时、前台恢复、失败提示和独立刷新入口
- [0060 — 新增「手动备份」：导出一个用口令加密的文件，导入时按文件内容覆盖本机](0060-manual-backup.md) — `已接受`；复用 0002 的封包格式，导出由 Host 写盘、导入由浏览器读文件；其中「右端一个文字按钮」的行形状被 0067 改成名称旁紧贴的图标
- [0061 — 动作提示归到「同步内容」底部，紧跟在动作行下面，预览不再是独立小节](0061-prompts-live-under-the-sync-actions.md) — `已接受`；把宿主提示/预览/确认框等八块移进同步内容小节，收进新的 `.prompts` 一列
- [0062 — 手动备份的落盘确认、接口协议与配置页视觉层级](0062-backup-protocol-and-settings-hierarchy.md) — `已接受`；加固导入导出 HTTP 和路径识别、禁止覆盖备份，统一章节/正文/说明与图标比例、手动备份两行的按钮去掉省略号并补充回归
- [0063 — 保留模型清单里 provider 的顺序](0063-keep-provider-order.md) — `已接受`；目录身份按出现顺序比较，移动 provider 算改动、重排 YAML 不算
- [0064 — 卡片上每一条操作产生的提示都带一个「移除」，宿主重算的提示按内容签名收起](0064-every-prompt-dismissable.md) — `已接受`；客户端持有的提示本地清除，`pendingInstall`/`dirProblems`/`keysProblems` 经 dismiss 路由按 `target+signature` 收进 `dismissed`，内容变了重新出现；状态接口补载荷校验
- [0065 — 同步最后生效的模型覆盖配置](0065-effective-model-overrides.md) — `已接受`；统一模型采集与写回的后覆盖语义，保留有效配置中的供应商/模型顺序，区分配置同步与宿主显示排序
- [0066 — 仓库只收源码与决策记录，本地产物一律忽略](0066-repo-keeps-source-and-decisions.md) — `已接受`；补齐 `dist/`、`coverage/`、日志、`.env`、`*.tgz` 等规则，把「`docs/` 除 `decisions/` 外不入库」从悬空注释落成 `docs/*` + `!docs/decisions/`
- [0067 — 「API 密钥」排到第二行、手动备份改用图标、转发密码脱敏展示](0067-part-order-and-backup-icons.md) — `已接受`；`PARTS` 改成 models/keys/plugins/patch/dirs（行序、合并与各份清单同源），密钥行文案只讲密钥，导出/导入换成紧跟名称的下载/拆箱图标（图标选择被 0068 调整），转发密码显示固定圆点而复制仍是真密码
- [0068 — 手动备份的两个图标改成同一只箱子的一对](0068-archive-pair-for-backup-icons.md) — `已接受`；导出改用 `IconArchiveOutlineRegular`，与导入的 `IconUnarchiveOutlineRegular` 同源（封箱/拆箱），否决自绘镜像上传图标，0067 的位置与尺寸不变（图标选择被 0069 调整）
- [0069 — 手动备份的两个图标改成同一只箱子里的一对箭头](0069-box-arrows-for-backup-icons.md) — `已接受`；新增 `src/client/BackupGlyph.tsx` 画出同一只箱子加朝上/朝下的箭头（导出朝上、导入朝下），箱盖与箱体逐字取自库里 `IconArchiveOutlineArtwork`，因为库里没有「箱子 + 向下箭头」；手动备份图标入口被 0070 取代
- [0070 — 手动备份去掉图标，直接点击导入导出整行](0070-backup-clickable-rows.md) — `已接受`；整行原生按钮包含标题与说明，保留展开/收起、键盘操作和忙碌禁用，移除图标及其专用样式
- [0071 — 模型清单写到真正生效的那一层](0071-sync-the-catalog-where-it-takes-effect.md) — `已接受`；家目录覆盖层（`$DSH_HOME/cordis.patch.yml`）排在 profile 之后且整体替换 `config`，清单按最后一层读写：两层都有时删掉家层那行（先封存进 `sync/`）让 profile 的清单重新生效，只有家层有时写进家层；卡片补报 `paths.modelsFile`
- [0072 — 合并写回前复验文件 mtime，别的程序改过的文件不写](0072-merge-writes-check-mtime.md) — `已接受`；快照与写回之间隔着两次 KDF 和一次上传，宿主恰在此窗口写的文件按字节比对会被整体覆盖且不留副本，改为写前 stat 对比快照 mtime、不符即拒；restore/undo/import 是显式覆盖不受此限
- [0073 — 损坏的状态文件移开重置，配置文件仍然报错](0073-damaged-state-moves-aside.md) — `已接受`；`sync-state.json` 撕裂从「所有路由 400、手动删文件」降级为改名 `.corrupt-<时间戳>` 后按空状态继续（0024 的无基线留档兜底），`sync.json` 仍报错；`writeAtomic` 同时补上 fsync
- [0074 — 第三轮审查：转发断连、dismiss 入队、pnpm 进程树与客户端互斥](0074-review-fixes-third-pass.md) — `已接受`；转发在目标断开时切断客户端而非挂死、`dismiss` 并入串行队列、Windows 超时用 taskkill 杀 pnpm 进程树且不再换候选重试、客户端 `run()` 互斥与「失败不重载、重载不清草稿」、`pickFile` 序号与 32 MiB 上限、动作请求 10 分钟兜底超时等

