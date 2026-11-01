# 0081 — key-index 防丢并集、同 realm lease 与请求来源边界

- 状态：已接受
- 日期：2026-11-01
- 范围：独立纯 helper、准确 1.2.6 两模块局部候选、离线隔离验证；不表示已修改或启用生产同步。

## 背景

模型插件的非敏感索引保存 provider 下的 `ref`、`alias` 等元数据。部署 1.2.6 把索引随 `plugins.configFiles` 同步，整文件 mtime/哈希选择及明确 import/restore/undo 覆盖能让空 `providers` 替代非空文档；真实凭据份的 refs 并集不能保护索引别名。来源 mtime 会被复制，不能当成本机实际写入时间。机制可证，本次事故的真实写者、空来源及首次发布提交仍未锁定。

实体仓库是 1.2.5，缺少准确 1.2.6 接线源码/对应历史。不得全量构建旧版覆盖较新部署。初版三段索引补丁的历史候选保留用于审计，但本次候选从原始发布字节重新构造，不对初版候选增量猜测应用。

后续审阅发现：仅按 owner 字面识别索引会漏掉已本地授权的 scoped 别名；容器 root 的字符串化不是结构验证；检查 signature 再 rename 若不共享 writer lease 仍有竞态。原发布入口的共同 route wrapper 又未检查来源，跨站语法错误正文也能到 JSON 解析层。这些是可验证的风险/新发现，不等于事故归因。

## 决策

### 1. 严格纯合并，不把损坏数据洗成空

[纯元数据模块](../../src/key-index-metadata.ts) 不含 IO、凭据解析或网络。只接受 version 1、对象根/providers、路由数组、有效字段类型；重复 ref、坏根/协议/版本/base64/UTF-8、过深或超 1 MiB 的输入/合并输出拒绝，不裁剪行凑上限。两侧均验证，错误不包含输入值。

按 `(provider route, ref)` 保留赢家顺序并追加缺失行。同 ref 的 `models`、`auto`、`disabled` 等及根 `endpoints`、`balances`/扩展字段仍全按赢家，不做通用深合并。own property 与 `Object.fromEntries` 避免原型路由误读。

Alias 是否可见逐字沿用实际 host `normalizeKeyAlias`：去 code point <32/127、trim、空则缺失、slice(0,40)。赢家规范化后无 alias 时才补另一侧可见 alias；合法赢家/补值仍保留原字面和精确字节，不额外清洗。两侧均不可见时不造 label。

缺失不是 tombstone；删 ref/清 alias 暂不跨机传播，旧数据可能回流，`disabled` 也不是永久禁用保证。多副本文件级赢家仍有字段到达顺序依赖。永久方向需共享 schema、操作/字段因果版本、显式 delete/clear tombstones、确认与回收；不在此候选开发 v2。

### 2. 只对实际 home 索引目标防丢

[配置模块精确清单](../../src/key-index-plugin-config-patch.json) 五段唯一替换：marker export、helper/queue imports、strict root、merge、apply。

- `root` 必须是字符串 `home`/`profile`，拒绝数组/对象等容器。
- 两参数 merge 无 paths，识别 `home` + 精确索引相对路径，不以 owner 字面绕过保护；原 mtime/同时间哈希仍选赢家。
- apply 先按原本地 declaration/configKey 白名单授权，不新增 owner 写权限，再用实际 target 与 home 索引的 resolve/Windows casefold 比较。因此 profileDir==homeDir 或等价祖先路径也受保护；真正独立的 profile 索引仍保持通用配置语义。
- 多条已授权声明指向同目标时，严格验证每份版本和索引，先按原规则选赢家并合并全部引用/可见别名，最终只 commit 一次。
- 保留非索引配置、ui-order savedAt 防回滚、配额、原必须备份、signature 复验、临时文件/0600、fsync/utimes/rename/清理流程。

### 3. 与模型共享同 realm 的索引 lease

[独立 queue 模块](../../src/key-mutation-queue.ts) 显式传 target，不 import 真实模型索引或默认路径；使用同 `Symbol.for('dsh-model-think-level.key-mutation-queues')`、global Map、resolve/Windows casefold、FIFO 与幂等 release。

受保护 apply 在读取 current 前 acquire，持有至计划、成功备份和最终 rename/错误清理结束，finally release。等候后逐份 `read.versions` 与 current signature 检查，旧 snapshot 零 backup/commit 拒绝，调用方必须重新 take/plan，不能以旧 refs 默默覆盖新索引。

这只协调同 realm、同规范 target 的参与者。不解决 Worker/其他进程、外部未参与 writer、其他 parts/凭据写入或整个同步事务；模型真实自动 scope 与底层 credential Promise 未 settle 不释放须由模型侧另验。现有 backup 回调不执行模型 mutation，不能在持有 lease 的回调中嵌套 await 同 target mutation。

### 4. 入口先发非敏感 marker，再判来源

[纯请求 helper](../../src/trusted-request.ts) 逐字保持现有模型 policy：WHATWG authority、Host loopback 或 IP literal、Origin 字符串匹配 URL.host、拒绝 serialized null/cross-site。没有 named LAN/trustedHosts 授权扩张；既有 literal LAN IP 语义不变。此 policy 不是严格 HTTP Host 语法、通用认证或秘密保护替代；现有宽松 authority/非字符串 Origin 语义未在这里悄然改成不同 policy。

[入口精确清单](../../src/webdav-request-integrity-patch.json) 只有两段：imports；共同 handler 的前置 fence。每个 handler 首先设置 `x-dsh-webdav-key-integrity` 为从配置模块 import 的 `KEY_INDEX_INTEGRITY_POLICY`：

```text
20261101-key-index-union+realm-lease+origin-boundary
```

不可信请求 drain 后立即固定 403 `{ error: '请求来源不受信任' }`，不回显输入；在 req.method、readJson、handle/engine/relay 之前返回。可信方法、正文解析/配额和 callback 自己发送响应的原契约不变。

### 5. 精确局部构建与产物

只单独严格编译 helper/queue/fence 与纯捕获 fixture，syntax check 两候选，不运行 1.2.5 全量 build/升级/浏览器产物。

| 候选/基线 | SHA-256 |
| --- | --- |
| [配置原始发布样本](../../.verify/webdav-1.2.6/plugin-config.original.js) | `53547f3c17aee30bfe0993bed940a27d57d0e0a5616960dad2079719c31a5c4e` |
| [入口原始发布样本](../../.verify/webdav-1.2.6/index.original.js) | `69ddb92b8a419aed7d2726cf7452080762136d998a6d60b61bb5650a877ccdeb` |
| [配置硬化候选](../../.verify/webdav-1.2.6/plugin-config.hardened.js) | `2d390afe802f0ce33943933669690c3974360bceaebd1269bacd0c4ba3ce6776` |
| [入口硬化候选](../../.verify/webdav-1.2.6/index.hardened.js) | `c56e0db77186b316a76aaf414df7878c1f0a01892da0672c5d54597e66f3377e` |
| [metadata helper JS](../../.verify/webdav-1.2.6/key-index-metadata.js) | `9d752482e759fdae5af72108671fa255ff1ec3b2cd0d1b44ced475a2ab1cf885` |
| [queue JS](../../.verify/webdav-1.2.6/key-mutation-queue.js) | `6f25602dc0a5621d2f1eafbcb1f541db25506e4d8ef8f7911c6f902465fdc77a` |
| [request helper JS](../../.verify/webdav-1.2.6/trusted-request.js) | `3e398859a4be8fa936cab79094fe43d9e441c7127e369f3f1bc1317037b66cc7` |

精确清单 SHA：配置 `ad07cf4e12850d1475d8fe8be155ce36d09accdabce631f14a6f50e9172c546c`；入口 `be1556ce0dfc4de981434773c5498c5e7879fae9776a09bcd3be240366a244c7`。JSON.parse 后已是正确 newline，禁止额外 unescape。

## 验证

- [metadata 纯单测](../../tests/key-index-metadata.spec.ts)：49。
- [原发布配置隔离单测](../../tests/key-index-plugin-config-126.spec.ts)：19，原空/少 ref、显式覆盖、坏数据、ui-order/其他配置回归。
- [索引硬化定向单测](../../tests/key-index-hardening-126.spec.ts)：31，实际 host alias 参考、strict wrapper、scoped owner/实际目标、一次 commit、stale snapshot、双向 lease、FIFO/release/失败与 non-index 不阻塞。
- [请求边界定向单测](../../tests/webdav-request-integrity-126.spec.ts)：58，pure policy 矩阵、准确原样本两段重建、实际 route/send/readJson AST 抽取在内存 mock 执行；跨站/null/mismatch/非法 Host/DNS rebind 均 marker+403 且 method/parse/handle/mock engine/mock relay 0，可信语法必错正文 marker+400 且 handle 0，方法/配额/委托响应不回归。

独立 strict TypeScript 与两候选 Node syntax check 退出 0；Vitest 3.2.7 仅上述四 suite **157/157 通过，无 skip，退出 0**。首次请求 suite 的唯一失败是 mock callback 只 return 数据而没自己 send；按真实契约补 mock，未放宽任何候选代码。原 99 用例持续全通过。

只使用合成 target/正文/headers，不 import/执行整个入口 apply、真实模型 index、engine/relay/credential API；独立捕获模型 queue 函数体不改，仅默认路径相邻 pure throw stub，全部显式 toy 参数。双向 lease 的模型 actor 是真实 queue + 合成 FS mutation，不等于实际模型全部凭据路径已验证。缺捕获 fixture 会显式 skip，不能当生产路径验收。

## 生产应用与仍未解决的边界

应用另由父代理/用户决定：先 GUI 临时停插件并确认无在途，保全原程序及证据；同时核两生产基线，三 helper create-only 安装，再原子 revision/CAS 替换配置模块、最后入口，逐文件核上表 hash。任何基线不符或 oldText 不唯一即停，不猜测替换旧版全树，不用状态 restore 试探。

必须实际重新加载模块图；旧 ESM dependency cache 缺 marker export 需要真正宿主重启，不承诺仅改字节/刷新页已经生效。parent 可用原同样语法必错正文分别核可信 marker+400、cross-site marker+403；只判新 handler/module graph，不能据此保证真实模型 writer lease 或所有 parts 安全。不能拿 GET status 充纯读：它会 relay.apply；既有 apply 初始化也会 engine()/relay，加载本身非全零副作用。重新启用/自动同步另决，先保持用户已设的 manual interval。

没有恢复双方皆已丢失 alias、删除传播/操作级来源历史、全面同源 schema 或跨进程事务；通用 config JSON 的敏感字段名假阳性等已知兼容边界也未整体修。密封副本可能含真实凭据，仍无只提旧 key-index 的安全现成接口；本候选不读/解封包、不验证凭据、不访问远端、不修改生产配置或状态。
