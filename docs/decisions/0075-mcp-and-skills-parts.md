# 0075 — 同步内容增加「MCP 服务器」和「技能」，MCP 行原地拆成一个视图，线上格式不动

- 状态：`已接受`

## 背景

「同步内容」此前是五份：模型供应商与模型、API 密钥、已安装插件、其它 profile 配置、附加目录。用户要求再加两项：技能（`skill`）和 MCP（`mcp`），并且两项都要真的同步。

DSH 里这两样的实际形状：

- MCP 服务器是 `cordis.patch.yml` 里的行 —— `name: '@deepseek-ai/dsh-mcp-client'` 的 map，要么单独一条（带或不带 `id`），要么整块 `insert:` 里全是这种行。这些行此前一直随「其它 profile 配置」这一份旅行，谁也没把它们单独看待过。
- 技能是 `$DSH_HOME/skills/<名字>/` 下的一个目录，含 `SKILL.md`（停用的技能叫 `SKILL.md.disabled`），宿主按目录扫描发现，没有登记表。

MCP 这一项面对一个别的项没有的约束：**没升级的电脑**会把 bundle 里它认识的形状重写回文件，`applyPatch` 以「wanted 列表里没有的行 = 不要了」走一遍。最直觉的做法——把 MCP 行挪进新的 wire 字段 `mcp`——会让老电脑读不到这些行，于是下次它同步时把对面机器的 MCP 服务器删个干净，而且要等两边都同步过一轮才显形。

## 决策

一、`mcp` 项是 patch 行的**视图**，不是新的线上格式。

- 判定（`isMcpEntry`，src/store.ts）：`name === '@deepseek-ai/dsh-mcp-client'` 的 map（带不带 `id` 都算），或无 `id` 的 map 且非空 `insert` 数组里**每一条**都是这种行 —— 整块判入；混着别种行的 `insert` 块留在 `patch`（按内容整块判，块里一行变了就整块换键，是 patch 行本来的语义）。
- 上线（`joinMcp`）：wire 的 `patch.entries` = 其余行在前、MCP 行在后；下线（`splitMcp`）：读 bundle 时按上面的规则拆回 `patch`/`mcp` 两个视图，`lift∘join = identity`。
- 于是没升级的电脑看到的文件与今天逐字节同形（线上根本没有 `mcp` 字段），一行都不会丢；升级过的电脑把这两类行分开开关、分开合并、分开报「两边都改过」。被否决的备选「wire 加 `mcp` 字段」就输在这里：它给存量用户埋一个只在双机同步后引爆的数据丢失，为一个纯内部的整洁付出实际代价。
- 合并语义跟 patch 行同款（列表替换、`null` 移除、`undefined` 不动），移除照常跨机器旅行——嵌在 `patch` 字段里，老电脑照样带着走。

二、`skills` 项照着 `dirs` 造一个（src/skills.ts 镜像 src/dirs.ts）。

- 根在 `$DSH_HOME/skills`（`ResolvedPaths.skillsDir`）；没给 homeDir 就没有这一项，与 `homePatchFile` 同一条「没有」而不是「猜一个」的规矩，临时 profile 的测试永远不会碰用户真正的技能目录。
- 每个含 `SKILL.md` 或 `SKILL.md.disabled` 的一级子目录是一个技能，目录里全部文件按路径排序进 `SkillSpec { name, files }`。`state.json` 与 `repos/` **不随行**：技能源条目的 `roots` 是本机绝对路径，换台机器就是错的，而且源可以再添加。
- 目录扫描是这台电脑的真相：在就同步，不在就是用户删了（这一点与 `dirs` 不同——附加目录的路径没挂载只是暂时不在）。删除不跨机器旅行：`applied.skills === null` 什么都不写，与 keys/dirs 同一个契约（一个同步永远删不掉谁手工做的东西）；写入只增不删。
- 保护照搬：一份 2000 个文件 / 8 MiB 上限、跳过 `node_modules`/`.git`、`under()` 防路径穿越、不写软链接。一个技能读不出来 = 那一个照旧拿服务器的拷贝顶上并在 `skillProblems` 报名字；连根都列不出来 = 整项让路（跟 `keys` 读不出整个凭据库同款），服务器那份原样穿行、不改本机一根文件。
- 合并对 `skills` 复刻 `dirs` 的两个特例：对面删了这边还有 → 推回去而不接删除；这边清空了对面还有 → 服务器那份穿过而不落盘。首次同步照常把服务器的技能写进空机器——那正是这项的用途。

三、两项开关默认开（`sync.json` 新增 `mcp`/`skills`，缺键读作开，与 `keys` 的旧配置宽容同款）。MCP 默认开是透明的：这些行本来就在跟着走；技能默认开是因为用户要的就是同步。关掉的语义是「这台不带」：本机的行/目录留给自己，服务器那份原样穿行，不写也不删。

## 影响

- 七份：模型供应商与模型、API 密钥、已安装插件、**MCP 服务器**、**技能**、其它 profile 配置、附加目录（0005 的「四份」历 0056 与本条后是七份）。卡片按这个顺序画两行新的复选框，提示文案说明「同步不会删掉任何技能」。
- `src/wire.ts`：`PARTS` 七项；新增 `McpPart`/`SkillsPart`/`SkillSpec`/`SkillProblem`；`SyncConfig`/`ConfigView`/`ConfigureBody` 加 `mcp`/`skills`；`StatusResult.skillProblems` 可按签名 dismiss（`DismissTarget: 'skill-problems'`），与 `dirProblems`/`keyProblems` 齐平。
- `src/store.ts`：`isMcpEntry`/`splitMcp`/`joinMcp`；`collect` 拆两类；`applyPatch` 按类走三态，一类是 `undefined` 就整类原样留着。
- `src/engine.ts`：bundle 读写口统一经 `splitParts`/`bundleParts` 桥接（`hashesOf` 改按 parts 视图记哈希——若照旧按 bundle 记，patch 份哈希恒不相等，每次同步都会空推）；`applyMerged` 的补丁写回条件必须带上 `applied.mcp`，漏了它第二台电脑收不到 MCP 行（测试抓到的那颗雷）。
- 跨版本双向安全：老电脑重写 bundle 不带 `skills` 字段时，新电脑读作「无人有意见」，下次同步把本机目录推回去（自愈）；`mcp` 因 wire 未变而无过渡问题。
- 代价：`mcp` 与 `patch` 的哈希在升级后一次性重算，首启后第一次同步两边都显示「都改过」，以内容比对消解（相同内容不算冲突，合并循环里的 `sameJson` 捷径）。混着别种行的 `insert` 块暂不拆——整块留在 `patch` 里照样同步，只是没有独立开关。
- 测试 +33：`tests/skills.spec.ts` 17 条（读取/成份/写回，含上限、穿越、跳过、根失败），`tests/store.spec.ts` 8 条（判定与三态），`tests/engine.spec.ts` 8 条（双机往返、删除不跨机器、跨版本自愈、根失败让路、开关关闭）。
