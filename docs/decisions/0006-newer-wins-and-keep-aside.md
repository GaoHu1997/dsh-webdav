# 0006 — 冲突时新者胜、败者留档 `sync/`；每次覆盖前先留档

- 状态：已接受
- 日期：2026-10-16（本仓库首次提交）

## 背景

两台电脑改了同一份，就得选一份。选项只有三类：

1. **停下来让人解冲突**：最安全，但把「点一下就完事」的动作变成了一个必须先理解上下文的流程。对一个设置页来说太重，而且用户看到的多半是「模型目录从 A 到 B 的差异」这种没法逐行裁决的东西。
2. **某一方永远赢**（本机永远赢，或服务器永远赢）：可预测但会稳定地丢掉另一台电脑的工作。
3. **按某个判据自动裁决**：需要每个分片有一个可比的时间戳。

第 3 条要成立，得先回答「本机这一份是什么时候改的」。文件系统的 mtime 不完美（复制/恢复文件会让它变），但在没有版本控制元数据的情况下，它是唯一现成的信号。存下来的是 `PatchFile.mtimeMs` 与 `ManifestFile.mtimeMs`（`src/store.ts:56,63`）。

另一半问题是**丢失的可见性**。任何「自动取舍」的方案都会丢东西；区别只在于用户能不能找回、以及知不知道该去找。整份覆盖的常见失败模式是：用户第二天发现某台电脑的模型不见了，但没有任何记录说明它去哪了、什么时候没的。

**留档的名字本身也会撞车。** 毫秒进文件名就是为了让同一秒里的两次留档不同名，但「同一毫秒」并不稀奇：一次同步里 `keepConflict()` 要留两份（本机那份与服务器那份），`keepBefore()` 还会再留一份，CI 上的 Linux 快盘把 8 次调用压进了同一个毫秒，只剩 6 个不同的名字——后写的把先写的悄悄覆盖掉，而那正是撤销指向的那一份。`tests/store.spec.ts` 因此红了。

## 决策

**冲突时新者胜，两边都留档。** 判定与留档都在 `src/engine.ts` 的合并循环里：

```ts
    if (changedHere && changedThere) {
      // Both sides moved. The newer of the two wins, compared against the stamp
      // the server wrote into the file.
      conflicted = true
      const serverAt = Date.parse(remote.created)
      const ours = localChangedAt(snapshot, part)
      if (!Number.isFinite(serverAt) || ours >= serverAt) {
```

- 服务器侧的时间戳是 `Bundle.created`——**写入那台电脑在密封时写进去的 ISO-8601 时刻**，不受服务器文件系统或时区影响。
- 本机侧是 `localChangedAt(snapshot, part)`：`plugins` 份取 `package.json` 的 `mtimeMs`，其余取 `cordis.patch.yml` 的 `mtimeMs`（`src/engine.ts:1012-1015`）。
- 平局（`ours === serverAt`）归本机（`ours >= serverAt`）。`Bundle.created` 解析不出来时（非有限数）同样归本机——宁可留本机的东西，也不因为对端的时间戳坏了就丢掉本地工作。
- 冲突一旦发生就 `conflicted = true`，循环结束后统一 `keepConflict()`：

```ts
async function keepConflict(engine: Engine, snapshot: Snapshot, remote: RemoteSide): Promise<string> {
  const dir = keptDir(paths)
  ...
  await keepAside(dir, 'this-computer', await seal(ours, config.passphrase)).catch(() => undefined)
  if (remote.body !== undefined) {
    await keepAside(dir, 'server', await seal(remote.body, config.passphrase)).catch(() => undefined)
  }
```

即：**两边都封进 `sync/`**，无论谁胜。败者显然要留；胜者也留，是因为「本机这份赢了、服务器的被人改过」这个事实本身值得留档。

**每次覆盖前先留档**，这是与上面独立的一条：

```ts
/** Seal this computer's setup into `sync/before-apply` before a merge writes. */
async function keepBefore(engine: Engine, snapshot: Snapshot): Promise<string | undefined> {
```

`applyPatch`/`applyManifest` 判定真的会改写文件时，先调一次 `keepBefore()`（`src/engine.ts:558-572`）。所以「本机文件即将被改」这个动作永远有一份密文前置留档 —— 包括「另一台电脑删掉了一行，本机也要删」这种最容易让人事后找不到东西的情形。

留档的位置与命名（`src/store.ts` 的 `keepAside()`）：

```
<profileDir>/.dsh-webdav-sync/sync/<YYYYMMDD-HHMMSSmmm>-<tag>.dshsync
```

tag 有五种：`this-computer`、`server`（冲突两侧）、`before-apply`（覆盖前）、`server-damaged`（服务器上的残片，见 [0007](0007-never-silently-overwrite.md)）、`server-replaced`（被 Upload 覆盖掉的文件）。**每个 tag 只保留最新 5 份**（`keep = 5`），按文件名排序后删旧的——前缀是零填充的 UTC 时刻，所以「按文件名排序」就是按时间排序，这一条靠的是前缀的格式，不是文件系统的 mtime。

文件名里的毫秒是刻意的：同一秒里的两份会落在同一个文件名上，后一份悄悄覆盖前一份，而前一份正是撤销指向的那份。但**毫秒也不是保证**（见上面的背景），所以名字不再只是「读一次时钟」：

```ts
let lastAsideAt = 0

export async function keepAside(dir: string, tag: string, data: string | Uint8Array, keep = 5): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  let file: string
  do {
    lastAsideAt = Math.max(Date.now(), lastAsideAt + 1)
    file = join(dir, `${asideStamp(lastAsideAt)}-${tag}${BACKUP_EXT}`)
  } while (await fileExists(file))
  await writeAtomic(file, data, 0o600)
```

两道防线管的是两个不同的来源：

- `lastAsideAt` 让**本次运行内**的时间戳单调递增：会重复的毫秒让给下一毫秒（`lastAsideAt + 1`），时钟往回调也不回退（`Math.max`）。交出去的每个名字都是新的，所以同一毫秒里的多次留档不会互相覆盖。
- `fileExists()` 管的是**上一次运行**留下的同名文件，以及时钟回调后重新走到的时间戳。名字被占用就让出这一毫秒再试下一个，而不是写上去覆盖——那里可能有一份是某次撤销指向的副本。

留档失败**永远不会**让同步失败（`keepConflict`/`keepBefore` 里的 `.catch(() => undefined)`）：留档是救生圈，不该成为沉船原因。

## 影响

正面：

- 「新者胜」让常见冲突自动收敛，不需要用户理解任何概念；两侧的判定依据（文件 mtime 与 `Bundle.created`）都是可解释的。
- 冲突双方都被留档，所以自动裁决永远有一个可找回的出口；`sync/` 里的东西同样是密文（用同一个口令封），并保持 0600。
- `before-apply` 让「本机文件被别的电脑的决定改掉」始终可回溯，这一点在删除传播的场景里尤其重要——`sync/` 是删除后唯一还能找到那份内容的地方。
- 所有留档都在本机，不上传，所以留档不会让服务器上多出可能互相覆盖的中间状态。
- 同一毫秒里的多次留档不会再互相覆盖：`keepAside()` 交出的名字两两不同，`tests/store.spec.ts` 把这一条钉住了。

负面：

- **语义冲突被静默裁决**。两台电脑同时改同一个 provider 的不同字段，会被判成整片冲突，败者进 `sync/`，胜者的版本整体生效——用户不会看到「你的 effort 设置被别人的 base URL 覆盖了」这样的提示，只会看到一条「上次同步替换了内容」的通知。
- **mtime 不是可靠的版本信号**：`git checkout`、从备份恢复、复制文件、甚至某些同步盘客户端都会改 mtime，从而让本机这侧在裁决中意外胜出或落败。`Bundle.created` 那一侧则是本机时钟说了算，两台机器时钟不同步时会偏。
- 「只保留最新 5 份」意味着留档会被后续同步挤掉。用户如果在冲突发生很久之后才发现，可能已经没有那份副本了。
- 每个 tag 5 份、五种 tag，`sync/` 目录会缓慢增长到约 25 个文件；没有清理命令。
- 名字里的时间戳不再严格等于系统时钟：一毫秒里挤进多次留档时，后面几个会比真实时刻略微超前（最多超前调用次数那么多毫秒）。它只用来排序，超前无害；反过来，时钟往回调时它会接着已有的值继续加，不会产生一个「更早」的名字。

## 验证

- `tests/store.spec.ts` 的 `keepAside > keeps replaced copies and prunes to the newest few`：8 次调用、`keep = 3`，断言 8 个名字互不相同、`sync/` 里只剩 3 个、最新 3 份存活。修复前它在 Linux CI 上只得到 6 个名字（`AssertionError: expected 6 to be 8`），修复后该文件 30 例全通过。
- 全量套件 208 例通过；`pnpm run typecheck` 与 `pnpm run build:all` 均 exit 0。
