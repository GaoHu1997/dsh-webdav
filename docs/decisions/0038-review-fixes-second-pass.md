# 0038 第二轮审查：一个真的能写出目录的漏洞，和几处只说不做的代码

- 状态：已接受
- 日期：2026-10-20

## 背景

又一次通读 `src/`。这一轮找到的问题比上一轮（0017–0029）少，但有一处是安全边界上的真缺陷：`dirs.ts` 的路径包含检查在 Windows 上可以被反斜杠绕过。其余是一批声明了却没人用的符号、说错对象的文档，以及一条本就测不出来的断言。

[0030](0030-review-findings-not-changed.md) 里判定不改的九条这次没有再动，也不再重报。

## 决策

### 决策一、`under()` 在 Windows 上按两种分隔符切分

复现：把 `{ path: '..\\..\\outside.txt' }` 放进 `dirs` 分片交给 `writeDirs`，在 Windows 上文件被写到配置目录之外的两级上级。

原因：`under()` 只用 `path.split('/')` 切，于是 `..\..\x` 看起来是**一个**无害的段；但 `join()` 在 Windows 上认反斜杠，把它当两段 `..` 走掉了。`readTree` 写出来的路径一定是 `/` 分隔的，所以这条只能来自别处写的包——也就是服务器上的数据，而 `engine.ts` 的形状校验只要求 `path` 是字符串。

**改。** Windows 上按 `/[\\/]+/` 切分；其他平台仍只认 `/`，因为那里反斜杠是合法的文件名字符，跟着切会把文件改名。同时把「绝对路径」的判断换成 `isAbsolute()`，它覆盖了原来只查前导 `/` 的情形（Windows 的 `C:\x`、`\\server\share`）。空段全部被滤掉后没有剩余段时也返回 `undefined`，不再落到 `join(root)` 去写目录本身。

`tests/dirs.spec.ts` 里补了一条用反斜杠、混用分隔符的用例；把修复退回去时它确实是红的。

### 决策二、读取上限改成边收边数

复现：让假服务器回一个 64 MiB + 1 字节的文件——`get()` 会先 `await response.arrayBuffer()` 把整份收进内存，再拿 `byteLength` 判断超限。判断是对的，但内存已经花掉了；服务器不给 `Content-Length`、或者给一个不实的长度时，上限就不再是上限。

**改。** 新增 `readLimited(response, limit)`：拿 `response.body` 的 reader 逐块读，累计超限就 `cancel()` 并抛同一条中文错误。`body` 为 `null` 时（某些测试替身）退回整份读取后再判。`drain()` 也走它——一个马上要丢掉的状态码响应不该被整份读进来。

同一处的解压路径一并收紧：`unpacked()` 的 `gunzipSync`/`inflateSync` 加 `maxOutputLength: MAX_BYTES`，把 `ERR_BUFFER_TOO_LARGE` 翻译成「解压后超过 … 字节」。否则几 MB 的 gzip 就能绕过读入上限，在解压那一步把内存吃掉。

### 决策三、`crypto.spec.ts` 那条被篡改的盐原本可能没被篡改

复现：偶发失败，`open()` 解出了 `{ a: 1 }` 而不是抛 `PassphraseError`。

原因：测试把盐的最后两个字符改写成 `00`；当随机盐本身就以 `00` 结尾时，这一改什么都没改，AAD 不变，认证自然通过。

**改。** 改成写 `00` 或 `01`（看原值），保证篡改一定发生。

### 决策四、删掉零引用的导出

全仓 grep 确认只有定义处命中，一并删除：

- `dav.ts` 的 `NotModifiedError`：从来没有 `throw` 过它；`get()` 的文档却说它「Throws `NotModifiedError`」，而实现返回 `{ notModified: true }`。类删掉，文档改成实话。
- `wire.ts` 的 `PART_LABELS`、`ProviderSpec`：卡片用的是自己那份 `PART_NAME`。
- `index.ts` 的 `WEBDAV_SYNC_NS`、`SectionConfig` + `sectionOf()`。
- `store.ts` 末尾的 `void Scalar` / `void YAMLSeq`，以及 import 里对应的两个名字：正文一直是只用 `YAMLMap` 的。

顺手把 `noUnusedLocals` 与 `noUnusedParameters` 打开了（`tsconfig.json`）。这一轮那几处「导入了不用、声明了不用」本来就是靠临时加这两个开关才扫出来的；开着它，下一轮不用再靠另一次审查才发现。打开后多余的位置只有四处，就是上面列的 `store.ts` 两个 `index` 与 `engine.ts` 的 `persistConfig`、`config`，已一并删掉。

### 决策五、两处说错对象的注释

- `index.ts` 里 `apply()` 头上压着**两段** JSDoc：前一段是 `apply` 的，后一段讲的是 `state.ts` 的内存口令，内容还是第二遍。合成一段，并让口令那段明确说它是「这里读回来的」。
- `saveStateIfUsable()` 的注释说「写一个记下新配置 key 的状态文件」，实现只 `ensureStateDir()`。注释改成它真做的事；顺手把函数里那句 `await import('./state.js')` 换成静态 import（同一个文件里的静态 import 表早就导入了 `state.js` 的别的东西，动态导入没有任何收益）。

### 决策六、`check` 路由里那层重复判定删掉

`ROUTE_CHECK` 先判 `!usable(config) && config.url.trim() === ''` 再调 `check()`，而 `check()` 第一句就是 `normaliseUrl(config.url) === ''`。两处判的是同一件事，用的却不是同一个函数（`trim()` 对 `normaliseUrl()`），`usable()` 还要额外看口令——于是「只差口令」的配置在路由层会漏到 `check()` 里，行为取决于走哪条路。留 engine 那一处。

### 决策七、卡片里用下标当 React key：不改

`WebdavSyncCard.tsx` 的目录行是 `state.dirs.map((path, index) => … key={index})`。`dirs` 是 `string[]`，同处的 `id` 和 `editDir(index)` 也全按下标索引；换成稳定 key 得把 `card-store.ts` 的 `dirs` 表示、`CardActions` 的签名一起改成带 id 的对象。而那一行只在 `path === ''` 时才渲染受控输入（非空行渲染的是纯文本），删中间一行不会把别人的输入内容搬到错位的框里——最坏情况是两个空行之间的焦点跳动。

**不改。** 代价与收益不成比例，记在这里免得下一轮再报。
