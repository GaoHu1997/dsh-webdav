# 0076 — 第四轮审查：合并里哈希 `undefined` 的崩溃、预览与同步各说各话、以及转发/安装/卡片的一批修正

- 状态：`已接受`

## 背景

用户要求「全面测试，看看有没有 bug、逻辑问题」。这一轮不预设范围：先通读 `src/` 全部模块，再针对每个可疑点写一次性探针复现（探针用完即删），确认之后才改。以下八条都先复现、后修，每条都补了回归测试。

八条里有一条是崩溃，其余是「说得跟做的不一样」：

1. **合并循环对 `undefined` 求哈希会抛异常**。`sameJson(a, b)` 是 `hashJson(nodeJson(a)) === hashJson(nodeJson(b))`，而 `stableJson(undefined)` 就是 `JSON.stringify(undefined)`，返回 `undefined`，`createHash().update(undefined)` 抛 `TypeError: The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received undefined`。触发条件是「两边都改过」且至少一边**没有**这一份——典型场景是没升级的电脑（不认识 `skills`/`mcp`/`keys`/`dirs` 某一项）把文件重写成没有那个字段，而本机正好改了那一份。因为异常发生在状态落盘之前，**每次重试都会再炸一次**，属于永久性故障。
2. **预览与同步对同一份数据的判断不一致**。`preview()` 自己算了一遍 `changedHere`/`changedThere`，与 `syncOnce()` 里的那份是两套代码。最明显的后果：服务器为空时的首次同步，卡片对六份都说「取回服务器的一份」，而同步实际上传。
3. **`restore` 的提示会点名没发生的事**。`here.push(part)` 落在 `if (remotePart !== undefined)` 之外，服务器不携带的份也被算作「已取回」。
4. **自动同步不理会 429 的 `Retry-After`**。`RateLimitedError.after` 算出来了、也测过了，但没人用：服务器要求等 600 秒，定时器照旧每分钟重试，而错误文案还写着「下次多等一会儿」。
5. **转发把集合当文件改名**。只有 `MKCOL`/`OPTIONS` 逃过 `.prop` 补名，于是转发自己创建的、没有扩展名的集合被后续 `DELETE`/`MOVE`/`COPY`/`PROPPATCH`/`LOCK`/`UNLOCK` 请求成 `名字.prop` 并得到 404。
6. **转发在多状态响应里丢尾巴**。`flushPending` 遇到未闭合的 `<href` 直接 `return`，即使已经是响应结尾；一个自闭合的 `<D:href/>` 会让它把该标签到响应末尾全部吞掉，而 `content-length` 又被丢掉，客户端无从察觉。
7. **安装 pnpm 的两条 Windows 路径都不通**。`spawn(..., { shell: command.endsWith('.cmd') })` 让 `cmd.exe` 自己重新拼命令行，`DSH_PNPM='C:\Program Files\nodejs\pnpm.cmd'` 被读成 `C:\Program`；同时内置候选只给 `runtime/pnpm/bin/pnpm.cjs`，而 win32 的 `runnable()` 只认 PATHEXT 里的扩展名，`.cjs` 永远匹配不上（实测随包发布的就是 `pnpm.cjs`/`pnpm.mjs`，没有 `.cmd` 垫片）。
8. **卡片三处「说的不是真的」**。目录行按内容判断是不是输入框，于是敲下第一个字符输入框就消失；「关闭同步」不清 `dirty`，之后的读取被脏表单跳过，界面继续显示已经关掉的地址和间隔；摘要用 `passphraseSet` 判断「未开启」，而关闭同步**故意保留**口令，于是关掉之后显示「已开启，地址待填写」；宿主记录的「上次同步失败」(`StatusResult.error`) 从来没画出来，无人值守的失败只能靠时间戳不再走动来猜。

## 决策

一、**存在性先于内容**。`sameJson` 只在两边都**有**这一份时才比内容：

```ts
if (local[part] !== undefined && remoteHas && sameJson(localParts[part], remotePart)) {
  return { take: 'same', conflict: false }
}
```

否决「让 `stableJson(undefined)` 返回 `'undefined'` 之类的哨兵值」：那会把「没有这一份」伪装成一份内容，两个都缺的机器会因此判为「相同」并跳过，而它们其实该走 `nothing` 分支；而且 `hashesOf` 早已跳过 `undefined`，可见「没有哈希」在类型上就是合法的，该在调用处守住。

二、**预览与同步共用一次判断**。抽出 `moveFor(input: MoveInput): PartMove`（`src/engine.ts`），把原来循环体里的全部判断搬进去，`syncOnce` 与 `preview` 各调一次、只对结果做各自的事：同步写盘并记 `here`/`there`，预览翻成卡片上的那句话。预览额外补一条 `remote.empty` 分支（服务器空 → 本机有这一份就是 `mine`，也就是「推送」）。`drop` 在卡片上没有对应的词，映射成 `remote`——那是这对答案里诚实的一半。

判断搬过去还不够：喂给判断的输入也得一样。`syncOnce` 在凭据服务读不出来时会把 `keys` 从本机这一侧整个删掉（「读不到」不是「没有」，一部分读出来更不能当成完整的一份上传），而 `preview` 少做了这一步，于是卡片承诺一次密钥上传、同步却不做。现在两处都按同一行删：

```ts
const localParts = partsOf(snapshot, carriedOf(remote))
if (snapshot.keysProblems.length > 0) delete localParts.keys
```


三、**点名要对着真正发生的事**。`restore` 的 `here.push(part)` 移进 `if (remotePart !== undefined)` 里：服务器不带的份，既没写也没删，就不该出现在通知里。

四、**`Retry-After` 是下限，不是建议**。定时器把配置的间隔当作下限、服务器给的延迟当作可能更长的一次等待：

```ts
wait = minutes * 60_000
try { await sync(current) } catch (cause) {
  if (cause instanceof RateLimitedError && cause.after > 0) wait = Math.max(cause.after, wait)
}
```

注意 `RateLimitedError.after` 是**毫秒**（`retryAfter()` 已经把秒换算过），第一版按秒处理，`Retry-After: 600` 被排成七天后，回归测试当场抓到——这也是给这个字段补上单位注释的原因。

五、**转发要记住自己造过哪些集合**。没有扩展名的路径无法从拼写判断是文件还是集合，所以不再猜：`MKCOL` 成功时记下该路径（`collections` 集合，随 `relay-paths.json` 一起持久化，`version` 仍是 1，缺键读作空），此后该路径及任意子孙路径一律按集合转发，`DELETE` 成功后忘掉它，`MOVE`/`COPY` 把这份记忆带到目标。`fileResource` 随之决定 `resourcePath` 与 `Destination` 要不要补 `.prop`。

否决「无扩展名且未记录过的一律按集合」：那会让 0046 定下的「文件资源补 `.prop`」对 `PUT /dav/a` 这类普通路径失效，现有两条转发测试立刻挂掉（`gives the base path to a client that dropped it`、`takes one doubled slash off the seam`）——它们的整个意义就是普通无扩展名路径要补名。

六、**XML 流式改写必须在结尾收口**。`flushPending(..., true)` 收到 `final` 时，未闭合的标签、自闭合的空元素（`<D:href/>`，没有文本也没有结束标签）都要原样吐出并清空缓冲，而不是 `return`。

七、**启动 pnpm 要绕开 cmd.exe 的重新分词**。`.cjs`/`.mjs` 用 `process.execPath` 直接起（`shell: false`），`.cmd`/`.bat` 才走 shell，且路径含空格时自己加引号（`cmd.exe` 会重新拼接整行，`spawn` 只负责整行加引号）。`runnable()` 对脚本文件直接放行，不再要求 PATHEXT。同时给 win32 补上 `pnpm.cmd` 候选。

八、**卡片只画它知道的事**。目录行改由 `editingDir: number | null` 决定（「这一行是手敲出来的」），不再由内容决定；`off` 分支清 `dirty`，与 `save()` 一致；摘要在 `url` 为空时答「未开启」，`url` 有而 `passphraseSet` 为假时答新的「地址已填，口令待填写」；新增一行 `role="status"` 显示 `StatusResult.error`，它在下一次成功同步时由宿主自己清掉，因此不需要关闭按钮。

## 影响

- `src/engine.ts`：新增 `PartMove`/`MoveInput`/`moveFor`（约 150 行，注释随逻辑一起搬），`syncOnce` 的循环变成 `switch (move.take)`，`preview` 变成同一函数的第二个调用者。合并逻辑从此只有一个副本；将来加第八份时只改一处。
- 预览对「服务器空」的首次同步、对「两边都没动」、对「对面删了而这边还有」的 `dirs`/`skills` 都给出与同步一致的答案；`take` 的四个取值语义不变，卡片文案不用动。凭据读不出来时预览与同步一样不提 `keys`。
- `restore` 的通知只列真正写过的份；`here` 变短是修复而非回归。
- `src/index.ts`：定时器多一个 `catch`，`RateLimitedError` 从 `./dav.js` 一并导入。
- `src/dav.ts`：`RateLimitedError.after` 补一句「毫秒」的注释（不改行为）。
- `src/relay.ts`：新增 `collections` 字段与 `knownCollection`/`changeCollection`，`relay-paths.json` 多一个 `collections` 键（旧文件照读，`version` 不变）；`propfindHrefTransform` 在结尾收口；`basicOf` 改成大小写不敏感并按第一个空格切分（顺带删掉那段永远不会抛的 `try`/`catch`）；`content-encoding` 为 `identity` 时也还原 href；客户端断开时销毁上游请求，不再占着连接等满 120 秒；`changeAlias` 写盘失败时回滚内存里的别名。
- `src/install.ts`：新增 `isScript`/`Launcher`/`launcher`，`runnable()` 认脚本，`run()` 收一个 `Launcher`；`DSH_PNPM` 指向带空格的 `.cmd` 从此能跑起来，内置的 `pnpm.cjs` 在 Windows 上也不再被跳过。
- `src/client/card-store.ts`：`CardState.editingDir`，`appendDir`/`removeDir` 维护它，`answer('off')` 清 `dirty`。
- `src/client/WebdavSyncCard.tsx`：目录行按 `editingDir` 渲染，摘要改判 `url`，新增「上次同步没成功」一行。
- `src/client/locales.ts`：新增 `cardSummaryIncomplete`、`lastSyncFailed`（中英各一条）。
- 测试从 555 涨到 573，新增 18 条：引擎 4 条（缺字段不崩、首次同步的预览、对面删了某份的预览、冲突时预览点名与同步一致）、密钥 1 条（凭据读不出来时预览不提上传）、定时器 1 条、转发 5 条、安装 2 条、卡片 3 条（打字期间行不消失、行号跟随删除、关闭同步采纳新状态）、渲染 2 条（摘要三种状态、失败提示出现与消失）。全量 21 个文件通过，两个 `tsc` 项目均无错误。
- 仍然存在、这次没动的：`MOVE`/`COPY`/`DELETE` 在上游成功而别名落盘失败时仍答 502（0050 明确要求「只在上游成功完成后记录」，改它要重定那张契约，不是这一轮的范围）；卡片对「同步会删掉某一份」没有词（`drop` 借用了 `remote`），要真正表达它得先加文案。
