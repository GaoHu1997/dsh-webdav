# 0071 — 模型清单写到真正生效的那一层

- 状态：`已接受`
- 相关：[0063](0063-keep-provider-order.md)（保留 provider 顺序）、[0065](0065-effective-model-overrides.md)（最后生效的覆盖行）

## 背景

用户报告：另一台电脑同步过去后，设置 →「模型」页里的供应商顺序与模型顺序都不变，重启 DSH 也不变，而这台的同步卡片上「模型供应商与模型」显示**已一致**。插件版本 1.2.0（含 0063 的保序逻辑）。

读宿主代码后发现，问题不在插件的写入格式，而在**写错了文件**：

- `dsh-app-boot` 的 `readProfilePatches()`（`lib/index.js:1127-1137`）把 patch 层按这个顺序拼起来：bundle 层 → profile 的 `cordis.patch.yml` → **`$DSH_HOME/cordis.patch.yml`** → 命令行 overlay。家目录那层**排在 profile 之后**。
- `composeEntries()` → `applyEntryPatches([], layers.flat())`：后者对 `config` 是**整键替换**，所以家层那条 `llm-pi-ai` 行上的 `config.providers` 完整盖掉 profile 行的清单。
- 用户那台电脑的 `~/.dsh/cordis.patch.yml` 里确实有这条行，且是旧顺序。

于是形成稳定的假象：插件把新清单写进 profile（对），宿主读到的是家层那份（旧顺序），而插件的哈希按「本机能读到的清单」记录，两边都算「已一致」，之后每次同步都不再动它 —— 卡死在这个状态。

## 决策

1. **按最后生效的层读**：新增 `modelsLayer(profile, home)`（`src/store.ts`）——家层有带 `config` 的 `llm-pi-ai` 行时清单来自家层，否则来自 profile（只是元数据的行不遮蔽，与 `collect` 同规则）。`collect()` 增加第三个参数 `modelsIn`，读哪份文件由它决定；其余 loader 行始终来自 profile。`Snapshot` 因此多了 `modelsPatch` 与 `modelsFile`。
2. **一份清单只留一个主人**：`reconcileLayers()`（`src/engine.ts`）在 sync / restore / upload 的 `take()` 之前跑一次：
   - 家层**没有**清单行 → 什么都不做（绝大多数电脑）。
   - 家层**有**、profile **也有**带 `config` 的行 → 家层这行只起遮蔽作用，把 `llm-pi-ai` 行从家层删掉（`withoutModels()`，其他行与注释原样保留，删空时写成 `[]` —— 宿主把 patch 文件当顶层数组解析，空文件会报错）。删前把那部分内容以封包形式存进 `sync/`（`keepLayer`）。
   - 家层**有**、profile **没有** → 家层就是这台电脑的清单，不算遮蔽；合并结果写进家层（`applyMerged` 按 `modelsFile` 落盘），profile 保持没有。
3. 修复也算一次写：`reloadNeeded` 置为真，卡片照既有文案提示重载；DSH 的 `dsh-hmr` 同时监听 profile 与家层的 `cordis.patch.yml`，所以热重载后顺序立刻反映到设置页。
4. 卡片在清单不在 profile 时多报一个 `paths.modelsFile`（`PathsView`），不假装 `patchFile` 就是清单所在。

被否决的备选：

- **只把清单写进家层**（不删遮蔽行）：两处各留一份清单，而宿主的 Models 页编辑的是 profile —— 家层那份会把用户的编辑一起吞掉，顺序问题只是换了个场合重演。
- **两份都写**：同样是两份清单，来源不明，用户在 Models 页的改动会被下一次同步默默盖掉。
- **不碰家层、只提示用户手动删除**：把这个 bug 变成用户的操作负担，而且卡片上的「已一致」会继续说谎。
- **改宿主或往配置里塞排序字段**：超出插件范围，也没有对应的宿主持久化证据（0065 已否决同类做法）。

## 影响

- 正面：修好了报告的现象 —— 修一次之后，那台电脑上真正生效的清单就是同步过来的那份，顺序（含 `providers` 键序与显式 `models` 数组）跟着走；家层被删掉的那部分可从 `sync/` 找回。
- 正面：清单重新只有一个主人，Models 页的编辑落在真正生效的文件里；「已一致」重新意味着「宿主看到的和服务器上的一致」。
- 负面：会改写 profile 之外的一个文件（`$DSH_HOME/cordis.patch.yml`）。只删其中的 `llm-pi-ai` 行，且删前封存；那个文件若本来靠家层放**只属于这台电脑的额外供应商**，那些供应商会随着清单一起让位给同步来的清单 —— 但这些额外项在「把家层清单写进家层」的方案里同样会被合并结果替换，差别只在于现在能从事后找回。
- 边界：只在「家层声明了清单」时有动作；没有 `DSH_HOME` 的路径集合（测试里的临时 profile）不带 `homePatchFile`，绝不读写真实的 `~/.dsh`。宿主启动时读家层的时机早于任何同步，所以修复后第一次仍需一次重载（`reloadNeeded`）才会看到新顺序。
