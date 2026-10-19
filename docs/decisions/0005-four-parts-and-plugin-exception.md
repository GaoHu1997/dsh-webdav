# 0005 — 同步分为 models/defaults/plugins/patch 四份，plugins 份永不删除

- 状态：已接受
- 日期：2026-10-16（本仓库首次提交）

## 背景

一次三方合并需要合并单位。单位太大（整个 setup 一份）则每次都整份冲突；单位太小则要维护的边界变多，且「同一处改动」的判定会变得琐碎。

回到 DSH profile 实际的样子：

- `cordis.patch.yml` 是一个 loader 行的顶层 YAML 数组。其中有**两个语义上独立、用户经常分别改动**的行：`llm-pi-ai`（模型供应商与模型目录）和 `agent-default-model`（新会话用哪个模型）。
- 其余的 loader 行——MCP server、权限预设、UI 设置、`insert:` 块等等——彼此之间没有共同语义，但它们都是「配置」，改动频率低且通常整块地增删。
- `package.json` 里的 `dependencies` + `dsh.profile.bundles` 是完全不同的东西：它决定加载什么代码，改动需要配一次 pnpm 安装。

按「一份」还是按「一行」划分是这里的核心取舍。按行分（每个 loader 行一个分片）会让分片数量随用户配置漂移，合并的基线也随之需要动态结构，且删掉一行会让它的基线无处安放。按语义分成固定的几份，粒度略粗但边界稳定、可预期。

另一个必须单独想清楚的是**删除**。镜像模式（服务器上少了就删本机的）能让两台电脑收敛，但对插件清单来说后果很重：插件清单是加载 shell 的东西（`dsh.profile.bundles`），把它删空会让 profile 起不来。用户「关掉插件份」的意图也不应该等于「把别的电脑上的插件清单删掉」。

## 决策

固定的四份，顺序即合并顺序（`PARTS`，`src/wire.ts:65`）：

```ts
export const PARTS = ['models', 'defaults', 'plugins', 'patch'] as const
```

| 分片 | 来源 | 卡片文案 |
| --- | --- | --- |
| `models` | `cordis.patch.yml` 中 `id: llm-pi-ai` 那一行的整个 `config` | 模型供应商与模型 |
| `defaults` | `id: agent-default-model` 那一行的整个 `config` | 默认模型 |
| `plugins` | `package.json` 的 `dependencies` + `dsh.profile.bundles` | 已安装插件 |
| `patch` | patch 里**其余**的 loader 行 | 其余 profile 配置 |

四份都各自可开关（`SyncConfig.models/defaults/plugins/patch`，见 [0003](0003-secrets-in-state-file.md)），每份单独哈希（`hashesOf`），一次同步逐份做三方合并。

三个设计细节：

**1. 两份模型配置存的是整行 `config`，不是只挑 `providers`。** `ModelsPart` 的注释写明了原因：

```ts
  /** The whole `llm-pi-ai` entry config, so fields beyond `providers` travel too. */
  config: Record<string, unknown>
```

只挑已知字段会让将来 DSH 新增的字段静默丢失；整行存下来，未知字段原样跟着走。

**2. `patch` 份排除三个 id**：`llm-pi-ai`、`agent-default-model`、以及本插件自己的 `dsh-webdav-sync`（`SELF_ID`，`src/store.ts:37,163`）。前两个已有专属分片，重复携带会让同一处改动同时触发两份；第三个是 composition 配置行，见 [0003](0003-secrets-in-state-file.md)。

**3. `plugins` 份永不删除。** 这一条在合并循环里是一个显式命名的变量（`src/engine.ts:274`）：

```ts
const removable = !first && part !== 'plugins'
```

注释解释了为什么：

```
    // A part the other computer took away is taken away here too — but never the
    // plugin list, which is what loads the shell, and never on a first sync,
    // where an absent part only means this computer has nothing to compare.
```

`removable` 只有在「两边都改了且服务器那份更新，而服务器上没有这一份」以及「只有服务器改了且服务器上没有这一份」两条路径上才起作用，此时 `applied[part] = null`（`null` 是「把它拿掉」的指令，`undefined` 是「别动」）。`first`（本机没有基线）也排除在外：首次同步时「对面没有这一份」只意味着没得比，不意味着「对面删掉了它」。

**4. 关掉的分片不删除远端内容。** `syncsPart(config, part)` 为 false 时，服务器那份被原样带过上传（`merged[part] = remotePart()`），本机不动：

```
      // Not carried with this configuration. The server's copy is carried through
      // the upload untouched — turning a part off must never delete it for the
      // computers that still sync it — and nothing is written here from it.
```

## 影响

正面：

- 常见的日常改动（改一个模型、换默认模型、装个插件）各自只影响一份，不会互相拖累，也不会因为「另一台电脑改的是别的份」而产生冲突。
- 分片数量固定为四，基线的结构（`state.local` / `state.remote` 的 `PartHashes`）也是固定的，不需要随用户配置演化。
- `plugins` 的例外保住了一个底线：任何同步路径都不会让一台电脑的 profile 失去加载 shell 所需的插件声明，包括一个「从没同步过插件」的电脑第一次加入时。
- 关掉某一份不会波及还开着它的电脑。

负面：

- **粒度是语义级的，不是行级的**。同一份内两台电脑各改一处仍然算冲突（走「新者胜」，见 [0006](0006-newer-wins-and-keep-aside.md)）。比如两台电脑分别往 `patch` 里加了不同的 MCP server，会被判成冲突，其中一份要被覆盖后从 `sync/` 目录找回。
- `patch` 份的「其余行」边界是脆的：新增一个语义上特殊、值得单独成片的配置行时，必须同步改 `PARTS`、`PART_LABELS`、`collect()` 的过滤条件、`SyncConfig` 的开关字段和 `syncsPart()` 的分支——五处必须一起改，没有集中的注册点。
- `plugins` 永不删除意味着**插件声明的删除需要用户手动做**：一台电脑删掉的插件行会留在其它电脑上，用户得自己在 `package.json` 里去掉。这是用「需要手动」换「不会误删 shell」。
- `patch` 份为空时（profile 里除三个 id 外没有其它行）`collect()` 直接不产出这一份（`src/store.ts:165`），于是远端也不会有 `patch` 字段。这是刻意的（空份不声明存在），但意味着「把 patch 份清空」这个动作在数据上表现为「这一份消失」。
