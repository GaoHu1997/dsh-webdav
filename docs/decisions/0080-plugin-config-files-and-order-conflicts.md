# 0080 — 自动同步显式插件配置，统一供应商顺序比较

状态：已接受

## 背景

`plugins` 原先只有安装清单，插件在 `$DSH_HOME` 保存的配置不会随其同步。要求用户手动启用附加目录既容易遗漏配置，也会把探测缓存、日志和运行状态混入备份。模型插件的 `ui-order.json`、`key-index.json` 和 `image.json` 都属于用户配置，其中排序文档的版本应由 `savedAt` 而非文件 mtime 决定。home Loader 覆盖层的非模型配置此前也没有被采集。

供应商顺序的 hash 已有序，但双方都改动时仍用排序对象键的通用 `sameJson` 判断相等。双方只重排供应商时因此被判成相同，本地顺序可能静默覆盖较新的远端。

## 决策

- 扩展现有 `plugins` 分片，增加可选 `configFiles`，不新增分片或提升 wire version。每条包含插件名、`home`/`profile` 根、相对路径、base64 JSON 内容及时间。缺字段、缺文件均为无意见，按文件求并集，不删远端文件。安装清单继续原有三方仲裁，文件独立按时间仲裁；`ui-order.json` 使用其 `savedAt`，时间相同用内容 hash 确定一致的赢家。
- 内置模型插件上述三个配置的精确清单。其他插件可在包的 `dsh.webdavSync.configFiles` 声明 `{ root, path }`；本地 profile 可用相同字段声明 `{ plugin, root, path }`。只读安装清单中包的 `package.json`；pnpm 内部元数据链接只能指向本 profile 的 `node_modules` 内，外部链接需本地 profile 声明。远端声明不授予本地写入权限：未知配置仍随备份携带，待本机有声明后才落盘。
- 声明限定插件名称末段对应的目录、显式小写 JSON 路径。拒绝绝对路径、两种分隔符穿越、Windows 设备名/ADS、隐藏路径，以及日志、缓存、历史、临时、数据库、凭据、同步、备份和运行状态路径。明确排除 `key-serves.json`、`fingerprint.json`。不递归发现 home JSON 或扫描整个 `node_modules`。旧的显式附加目录若落入已识别插件命名空间，读取也应用此白名单，配置写入由 `plugins` 接管。
- 配置最多 128 个、单文件 1 MiB、合计 8 MiB，读取时实行上限。JSON 深度有上限，常见内联凭据字段拒绝同步，配置中的 `ref`、`keyRef`、`apiKeyEnv`、`secretEnv` 只贡献引用，实际值仅由开启的 `keys` 分片取得。配置契约仍要求插件不把其他形式的秘密写入配置，通用机制不声称可以识别任意字段里的秘密。
- 数据路径的全部祖先和文件检查符号链接/重解析及类型，读取用有界 handle 并复核 inode、时间和路径；写入前、备份后、rename 前再次核验。临时文件独占创建，写入和 fsync 后原子替换。快照到应用期间的变化拒绝覆盖；配置备份失败也拒绝覆盖。Node 的路径 API 无目录 handle 相对 rename，无法承诺抵御同权限进程恰在最后检查与 rename 之间替换父目录，但没有放松现有检查，并增加了多次复核。
- 生图 `outputDir` 在 home/profile 下的绝对路径转换成相应根标记，写入时按目标机器展开。其他绝对输出目录用本机保留标记，目标已有值继续使用，无已有值用 `generated-images`，避免复制源机用户名路径。相对输出目录照常同步；通用插件配置的任意路径字段不自动改写，扩展声明者须使用可移植的内容。
- `patch` 的可选 `homeEntries` 携带 home Loader 配置，MCP home 行仍由 `mcp` 开关管理。每机写回自己的 home 层，保留 profile/home 的 WebDAV 自身配置和默认会话模型；旧备份缺 `homeEntries` 不删除本机 home 行。普通 profile Loader 行继续在 `patch`。
- 双边内容相等判断直接复用已经计算的分片 hash，使 models 比较与 `modelsIdentity` 完全一致；preview 和 sync 继续共用 `moveFor`。
- sync、preview、export、restore、undo 均使用同一配置采集/应用路径。import 的插件和实际密钥也遵守各自开关（覆盖此前手动导入的例外）；其他分片保持既有导入语义。`ui-order.json` 即使显式恢复、导入或撤销也不回退更高的 `savedAt`。覆盖前的加密副本包含插件配置。

- 旧版 `dirs` 备份里放在附加目录中的已识别配置（如 `~/dsh-model-think-level/key-index.json`）没有 `configFiles` 标记。覆盖式恢复/撤销时，读取阶段按声明目标逐条精确匹配，把命中的文件转成 `configFiles` 再走同一应用路径（`adoptLegacyConfigs`）；缓存、探测文件和未命中声明的一律拒绝，非覆盖路径（保留本机、跳过）继续整体拒绝，避免旧目录备份绕过 `plugins` 的开关和冲突裁决。
- home 层「删空」必须能被表达：home patch 文件存在时，`take` 对 `patch`、`mcp` 写入 `homeEntries`（本层没有这些行时就是显式空数组），文件不存在则字段缺省表示无意见；`moveFor` 以字段是否存在判定，不再以本层是否还有行判定。显式空数组只在本地状态 `homeRows` 记录过该分片时才被信任，否则视作「碰巧空着的 home patch」而剥离，不让另一台电脑据此删掉本机行。

否决递归同步所有 JSON/整个 home：无法可靠区别配置与缓存、秘密和状态；否决只推荐附加目录：不是自动同步，且会绕过排序文档自身版本；否决单独新增 config 分片：引入额外开关和行，对现有 `plugins` 协议的可选扩展足以表达需求。

## 影响

开启 `plugins` 即携带已识别/已声明的插件自有配置，不依赖 `dirs`；两台不同 home/profile 路径的电脑能自动同步。排序文档不会被 mtime 较新的旧内容回退，供应商双方重排会正确报告冲突并保留副本。旧版只把配置写在附加目录里的备份仍能恢复这些配置；删除 home 层最后一行会真正传播到其他电脑，而不会被当成旧备份的「无意见」复活。新回归用临时 profile 和内存 FakeDav 验证，不进行真实同步。所有测试在 setup 中固定临时 `DSH_HOME`/profile 环境，防止 Host 路由或定时器测试退回执行者的真实 home。

未声明的第三方插件文件不会被发现或写入，这是一项有意保留的安全边界，并非所有插件自动兼容。旧版仍能读安装清单和普通 patch，但可能在重新封包时丢弃可选字段，因此参与同步的机器需同时升级，才能可靠保留新配置。版本号、发布、已安装包和运行中的 GUI 不在本变更范围内。
