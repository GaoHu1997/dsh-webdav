# 0027 坏掉的文件不等于没有这个文件

- 状态：已接受；`sync-state.json`「读不出来即报错」的部分被 [0073](0073-damaged-state-moves-aside.md) 取代（移开重置后按空状态继续），`sync.json` 与缓存副本的处理不变
- 日期：2026-10-16

## 背景

`readJson()` 原来这样处理：

```ts
try { ... } catch { return undefined }
```

`ENOENT` 和 `JSON.parse` 失败、非对象的结果走的是同一条路，都被当成"文件不在那儿"。

对缓存副本 `sync-server.dshsync` 来说这个宽容是对的——那只是一份留档，读不出来就当没有，插件会去服务器重新取。

对配置和状态文件就不对了：

- `sync.json` 读不出来 → `loadConfig()` 返回默认配置，地址和口令都成了空字符串。界面上表现为"设置没了"，而磁盘上明明有一份。
- `sync-state.json` 读不出来 → `loadState()` 返回 `{}`，`freshState()` 看到 `state.key !== stateKey(config)` 就返回一份只有 key 的空状态。于是 `first` 为真，本机所有分片都被认成"服务器那边改了"，配置被接管。

第二种尤其糟：文件坏了，插件的反应不是告诉用户"这个文件坏了"，而是照着基线不存在的样子干活。

magpie 在这一点上给出的答案是「写前留档」：`saveState()` 先把解不开的旧文件挪走再写新文件，所以一个坏掉的状态文件不会被静默丢弃。这里采用更前面的一个判断。

## 决策

只有**不在那儿**才算没有。文件在却读不出来是另一回事，说出来：

```ts
async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (cause) {
    if (isMissing(cause)) return undefined
    throw cause
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new Error(`${file} is not readable JSON: ${message(cause)}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${file} does not hold a JSON object`)
  }
  return value as Record<string, unknown>
}
```

缓存副本走的是另一个入口 `openCache()`，它仍然把读不出来当成没有——留档不该挡住同步。

抛错之后用户并不是卡住：每条路由都会经过 `engine()`，而 `configure()` 并不需要先读状态。用户重新填一次地址和口令，`sync.json` 就被覆盖，状态文件仍然坏着但已经不影响使用。状态文件的问题则会出现在每一次同步的提示里，并且 `recordFailure()` 自己包了 try/catch，坏状态不会让它连带失败。

## 影响

正面：坏掉的配置和状态文件会点名自己，用户能去修或者直接重来；不再有"设置悄悄变空"和"配置被无声接管"。

负面：以前能被静默跳过的一种情况现在会失败——磁盘坏了、文件被截断、有人手改过 JSON。原来那种失败是静默的数据丢失，现在的失败是看得见的错误。

被否决的备选：
- **坏状态时退回"把本机上传上去"**。那会用本机的内容盖掉服务器上唯一还在的一份。
- **坏状态时自动把状态重置成空再继续**。和原来的行为一样，只是多留了个文件。
- **给状态文件加备份环**。magpie 的答案是「写前留档」，本项目已经有 `keepAside()` 可以借，但那是解不开之后的事，坏文件被当成"没有"这个问题得先解决。
- **在 `freshState()` 里区分"空"和"坏"**。判据拿不到——`loadState()` 已经在读文件的时候把两者合并了。

## 相关

- `docs/decisions/0028-say-what-the-chain-says.md` —— 错误信息沿着 `cause` 链说话。
- `docs/decisions/0024-adopting-server-keeps-local.md` —— 接管前先留副本。
- `docs/decisions/0011-state-key-isolation.md` —— 空状态会被当成一次新的加入。
