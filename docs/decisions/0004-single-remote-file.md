# 0004 — 远端只保留一个加密文件，`node_modules` 不参与同步

- 状态：已接受
- 日期：2026-10-16（本仓库首次提交）

## 背景

「把 profile 同步到服务器」有两种显然的形状：

1. **镜像整个 profile 目录**（逐文件上传），像 rsync 或 Git 那样。
2. **把配置收拢成一个整体**，作为一份文件上传。

profile 目录里实际有什么：`cordis.patch.yml`（几 KB 到几十 KB 的 YAML）、`package.json`、`node_modules/`（几十上百 MB、几万个小文件）、以及各种状态与缓存文件。

第一方案会立刻撞上几件事：

- `node_modules` 的体积与文件数让每次同步都变成一次大规模上传，而 WebDAV 服务器普遍有请求频率限制（代码里就点名了 坚果云 按账号计请求数，见 `src/dav.ts:9-10`）。逐文件同步在这种配额下不可行。
- 逐文件同步需要一套自己的删除检测，否则另一台电脑上删掉的插件在服务器上永远留着；而删除检测在没有可靠元数据时必然是启发式的。
- 状态与缓存文件不该同步，需要一份排除清单，而排除清单会随着 DSH 版本变化而失效。
- 冲突面从「一个整体」变成「每个文件」，两个文件半新半旧地混在一起会得到一个谁也不认识的状态。

第二方案的代价则集中在「怎么合并」。一台电脑改了模型、另一台加了插件，如果只有整份文件，就只能整份覆盖。

## 决策

远端只放**一个**加密文件：

```
<WebDAV 地址>/dsh-webdav/dsh-profile.dshsync
```

常量在 `src/wire.ts`：`REMOTE_FOLDER = 'dsh-webdav'`、`REMOTE_FILE = 'dsh-profile.dshsync'`、`BACKUP_EXT = '.dshsync'`。理由写在常量旁边：

```
 * Folder made inside the WebDAV address, and the one file kept in it. One sealed
 * file rather than a mirror of the profile: the merge is three-way per part, so
 * the server only ever holds whole versions of the whole setup.
```

这份文件是一个 `Bundle`（`src/wire.ts:140-151`），带 `format: 'dsh-webdav-sync-backup'`、`version: 1`、`created`（ISO-8601，合并的平局判据）、`app`，以及四个可选分片字段 `models` / `defaults` / `plugins` / `patch`。分片放在**一个**文件里，所以远端是全有或全无的一个版本，不会出现半个 setup。

**`node_modules` 不参与同步**，改为同步「声明」并在本机重新拉包（`src/install.ts` 文件头）：

```
 * A sync can bring in a `package.json` naming plugins this computer has never
 * installed. The profile's `node_modules` is not synced — it is a build product,
 * tens of megabytes of it — so the declaration travels and the packages are
 * fetched here instead.
```

同步的 `plugins` 份只有两样东西（`PluginsPart`）：`package.json` 的 `dependencies`，与 `dsh.profile.bundles`。声明同步过来后，卡片提示「有插件尚未安装」，点「安装缺少的插件」在 profile 目录跑 `pnpm install`——也就是 DSH 自己的插件管理器用的那条命令，包来自同样的 registry，供应链规则不因为本插件而改变。

`@deepseek-ai/dsh-` 开头的内置包会被跳过（`BUILTIN_PREFIX`，`src/store.ts:39`）：它们随 DSH 一起安装，不属于 profile。

同一份文件内还把「写入带版本条件」做成了默认：读取时记下的 ETag 用于写入时的 `If-Match`，另一台电脑在这中间写过就会被拒绝（`ChangedError`）而不是被静默覆盖。

被否决的备选：

- **镜像整个 profile 目录**：`node_modules` 的体量与服务器请求配额都不允许。
- **每个分片一个远端文件**：可以让「只改了一份」的同步只上传那一份，但会让远端状态需要额外的一致性维护（四个文件不可能原子地一起更新），且与 magpie 的「一份文件」设计背离。当前用本地缓存 `sync-server.dshsync` 换取了同样的效果——「只本机改过」的同步不必下载它正要覆盖的文件。
- **在服务器上按插件名分目录存 `node_modules`**：把供应链问题搬到了服务器，且让恢复变得依赖服务端行为。

## 影响

正面：

- 一次同步的成本与 profile 真实体积（几十 KB）成正比，而不是与 `node_modules` 成正比；对按请求计费的 WebDAV 服务商友好。
- 远端永远只有一个文件要操心：备份、恢复、迁移、以及「我到底有没有上传成功」都是同一个答案。地址换文件夹时也只是换个文件夹。
- 声明与实现的分离让「恢复一台新机器」变成一个可解释的动作：声明同步进来 → 提示缺包 → 本机 pnpm 拉取。
- 条件写（`If-Match`）让两台电脑同时同步时被拒绝而不是静默覆盖。

负面：

- **恢复一台新机器不是一步完成的**：同步之后必须再跑一次 pnpm（自动同步的定时器不会替你装包，只有卡片的「安装」动作或用户手动跑）。
- `pnpm install` 需要本机有可用的 pnpm。代码按 `$DSH_PNPM` → `$DSH_RESOURCES_DIR/runtime/pnpm/bin/pnpm.cjs` → PATH 的顺序找（`pnpmCandidates`，`src/install.ts:42-53`），找不到时会明确报错提示设置 `DSH_PNPM`。
- 声明镜像的另一面：别的电脑在 `package.json` 里删掉的插件行，在本机也会消失（`applyManifest`，`src/store.ts:328-339`）。**但这只是文件里少一行，`node_modules` 里的包不会被卸载**——声明与实际安装状态会短暂不一致，直到下一次 pnpm 操作对齐。
- `MAX_BYTES = 64 * 1024 * 1024`（`src/dav.ts:67`）是从服务器读回的上限；正常备份远小于它，但它意味着将来若有人把大块数据塞进分片，会被这个上限挡住。
