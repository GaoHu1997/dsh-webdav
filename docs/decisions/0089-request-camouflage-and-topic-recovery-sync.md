# 0089 — 请求伪装与旧话题恢复也随插件配置同步，旧话题恢复改名避开 history

状态：已接受

## 背景

`dsh-model-think-level` 2.4 前后新增了两份按路由保存的开关文件：`camouflage.json`（该路由以 Codex / Claude 官方 CLI 的身份发请求）和 `history-compat.json`（该路由允许在 Responses 拒绝旧话题时恢复一次历史）。它们和 `ui-order.json`、`key-index.json`、`image.json` 一样是用户配置，却不在同步范围里：

- `src/plugin-config.ts` 的内置清单只列了后三份，包自身也没有 `dsh.webdavSync` 声明，所以新文件从来进不了 `plugins.configFiles`。
- 即使声明，`history-compat.json` 也会被 `declaration()` 的 `FORBIDDEN` 拒绝：任何一个由 `[._-]` 分隔的 `history` 段都按会话历史处理，这类文件一律不带走。名字本身就把这份开关挡在同步之外。
- 自动继续的开关和次数全在浏览器 localStorage（`dsh-model-think-level.auto-continue.enabled` / `.auto-continue.config`），宿主侧没有文件，文件同步结构上带不走。

另有一处语义风险：`mergeConfigFiles` 按整份文件的时间仲裁，只有 `ui-order.json` 用自己的 `savedAt`。这两份文件是「每路由开关」的字典，两台电脑各改不同路由时，后写的那整份会盖掉另一份里别的路由。

## 决策

- 内置清单加入 `camouflage.json` 与 `topic-recovery.json`，`dsh-model-think-level` 的「已安装插件」自动携带它们，与前三份同一套声明、开关和冲突规则，不新增分片或设置项。
- 插件包同时在 `dsh.webdavSync.configFiles` 声明这两条 `{ root: 'home', path: 'dsh-model-think-level/<name>' }`，让声明跟着包走；声明只是自描述，远端声明依旧不授予本机写权限。
- 旧话题恢复的落盘文件名改为 `topic-recovery.json`，因为 `FORBIDDEN` 拒绝 `history` 段是刻意设计（避免会话历史混进配置）。旧版写下的 `history-compat.json` 不删也不失效：插件第一次读取新名文件不存在时，读同目录旧名、解析成功后写入新名，之后以新名为准。同源 API 路由 `/dsh-model-think-level/history-compat` 是接口名，不改。
- 自动继续暂不纳入同步：它现在只是浏览器本地偏好，没有任何出站请求身份或路由状态跟着走；要同步需要先在宿主落一份文件并加入声明，属于另一件事。

## 影响

两台电脑之间请求伪装和旧话题恢复开关不再需要手动搬运，也不依赖附加目录；`camouflage.json` 与 `topic-recovery.json` 只含路由名和开关，没有秘密，远端镜像里不会出现本机绝对路径。已经存过 `history-compat.json` 的电脑不会丢开关，升级后第一次读到就迁移；旧版客户端不认识 `dsh.webdavSync` 声明，只是忽略它，不会因此报错。

两台电脑各改不同路由的开关时，仍按整份文件时间仲裁，后写的一方胜出，可能丢掉另一方对别的路由的改动——与既有其他配置同一取舍，未引入字段级合并；若实际使用中出现，可为这两份文件各自的 `savedAt` 补一条 `stamp()` 规则，而不改动协议。新增回归在 `tests/plugin-config.spec.ts` 用内存 FakeDav 验证跨机携带、镜像不含本机路径，以及旧备份缺这两份字段时不删除本机文件。
