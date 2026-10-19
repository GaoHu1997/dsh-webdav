# 0022 解封之后先看分片长得对不对

- 状态：已接受
- 日期：2026-10-16

## 背景

`openRemote()` 打开服务器上的文件，成功之后就直接把解密结果当成 `Bundle` 用。类型断言骗过了编译器，运行时没人检查过形状。

结果是几种坏包都能走得很远，然后以原始异常的形式炸出来：

- `patch: { entries: 5 }` → `wanted.map is not a function`；
- `plugins: [1, 2, 3]` → 后面读 `dependencies` 时得到 undefined，再往下是 `package.json` 的字符串索引；
- `models: 'nonsense'` → 哈希能算出来，然后写进本机的 `llm-pi-ai` 行。

坏包还有可能"看起来能用"：分片形状对，内容是空的，于是合并结果是一份空配置，本机的模型配置被悄悄清空。

这类文件不是"不是我们的"（那是别人的备份，不该动），而是"是我们的，但坏了"。两种情况的处理方式不同：别人的文件要留个错误让人去处理，坏掉的文件要走已有的重建路径。

## 决策

`openRemote()` 在格式检查之后跑一遍运行时校验：

```ts
function unreadablePart(bundle: Bundle): Part | undefined
```

逐个分片：

| 分片 | 要求 |
| --- | --- |
| `models` / `defaults` | 有 `config`，且是普通对象 |
| `plugins` | 有 `dependencies`（普通对象，值全为字符串）、`bundles` 是字符串数组 |
| `patch` | 有 `entries`，是数组，元素是对象或字符串 |

缺席的分片是合法的——一台不带插件列表的电脑就什么都不写那个键。

形状不对就抛 `CorruptError`。这是有意的：`CorruptError` 已经有一条完整的善后路径，会把服务器上的字节先存进 `sync/server-damaged/`，然后在本机有基线的情况下按合并结果重建，没有基线则明确拒绝。走这条路径而不是新造一个错误类型，是因为"我们的文件坏了"和"文件被截断了"要做的判断本来完全一样。`upload()` 那侧的分类本来就把 `CorruptError` 当作"读不出来、可以被替换"，所以上传一个形状不对的文件也能覆盖得掉，不会变成死路。

## 影响

正面：坏包给出的是一句能看懂的话而不是 `TypeError`，并且**说得清是哪一片**：`the file on the server is a dsh sync backup that cannot be read: the part "patch" is not shaped like one this plugin wrote — use Write over it if it should be replaced with this computer's setup`；本机已有的编辑不会因为坏包被清空。

没有基线时，`CorruptError` 的这句话会原样透给用户（末尾补上 Write over 的提示），而不是套用「不是你的备份」那句 —— 那个文件确实是你的备份，只是读不出来，告诉用户"这不是你的"会把他引到错误的操作上去。`NotBackupError` 才说那句话。

负面：`openRemote()` 每次多一次遍历，四个分片、几十 KB，可以忽略。

被否决的备选：
- **用 zod 之类的库校验**。为了四个分片引一个运行时依赖，而 peer 依赖里还没有它。
- **抛 `NotBackupError`**。那会让 `upload()` 拒绝覆盖用户明说要替换的文件，也会告诉用户"这不是你的备份"，而它确实是。
- **在 `applyPatch`/`applyManifest` 里逐个防御**。四处防御会漏，而且合并已经开始改文件了。

## 相关

- `docs/decisions/0007-never-silently-overwrite.md` —— 坏文件不静默覆盖。
- `docs/decisions/0020-apply-patch-without-config-key.md` —— 本机一侧的形状容错。
- `docs/decisions/0017-blind-write-baseline-guard.md` —— 基线判断依赖远端哈希，也依赖远端确实是分片。
