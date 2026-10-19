# 0012 — 地址归一化：`basePath` 记下地址自身的路径，`url()` 不再拼出双斜杠

- 状态：已接受
- 日期：2026-10-16（全面检测阶段发现并修复）

## 背景

`Dav` 的职责之一是「把配置里的地址和一个相对路径拼成一个完整 URL」：

```ts
  url(...parts: string[]): string {
    const url = new URL(this.base.toString())
    url.pathname = `${url.pathname}/${parts.join('/')}`
    return url.toString()
  }
```

构造函数里已经把尾斜杠去掉了（`src/dav.ts:118`）：

```ts
    const path = parsed.pathname.replace(/\/+$/, '')
```

写这段代码时的假设是：**去掉尾斜杠之后 `pathname` 就是「地址自己的路径」**，左边接一个 `/` 再拼上 `parts` 就得到正确结果。对 `https://dav.jianguoyun.com/dav/` 这个假设是成立的（去掉尾斜杠后是 `/dav`），所以一路测试都通过——`tests/harness.ts` 的 `configFor()` 和 `tests/dav.spec.ts` 的 `BASE` 都是 `https://dav.test/dav`，即**带路径**的地址。

这个假设对**不带路径**的地址不成立。WHATWG URL 不允许一个特殊协议（http/https）的 pathname 为空：把 `''` 赋给 `pathname`，它会被规范化回 `'/'`。

```
input            http://h:1
  after strip    pathname="" → 赋值后被规范化回 "/"，toString=http://h:1/
  url() result   http://h:1//dsh-webdav/dsh-profile.dshsync     ← 双斜杠
```

于是所有以服务器根为地址的配置（`https://dav.example.com`、`http://192.168.1.10:5005`、各种只给域名的自建 WebDAV）都会拼出 `//dsh-webdav/dsh-profile.dshsync`。

**真实服务器的反应**：用一个真实的 WsgiDAV 4.3.5（`cheroot` 起 HTTP）验证，单斜杠路径全部正常，而 `//dsh-webdav/` 与 `//dsh-webdav/dsh-profile.dshsync` 一律 **400**：

```
--> PROPFIND //
<-- 207
--> PROPFIND //dsh-webdav/
<-- 400
--> HEAD //dsh-webdav/dsh-profile.dshsync
<-- 400
--> GET //dsh-webdav/dsh-profile.dshsync
<-- 400
```

所以 preview / sync / restore / upload **全部失败**，错误原文是 `reading dsh-profile.dshsync from the WebDAV server: HTTP 400`。

更糟的是 `check()`（「测试连接」）**报假成功**。原来的 `check()` 只对几种状态单独处理，其余一律落到「没有文件夹就建一个」：

```ts
    const folder = await this.propfind(`${this.url(REMOTE_FOLDER)}/`, '0')
    if (folder.status === 404 || folder.status === 409 || folder.status === 410) await this.mkcol()
    else if (folder.status === 401) throw new LoginError()
    else if (folder.status === 403) throw await this.forbiddenMessage()
    return { ok: true }
```

400 既不是 404/409/410，也不是 401/403，于是**直接返回 ok**；紧接着 `dav.stat()` 又走 HEAD → 非 200 → 转 `length()` → PROPFIND 非 207 → `undefined` → `{exists: false}`，于是卡片上显示的是「服务器已应答，上面还没有你的备份，第一次同步会写一份」。

用户看到的现象是：**测试连接说一切正常，然后点同步必然失败**，而且失败原因（HTTP 400）看起来和「测试连接说没问题」直接矛盾。这是本轮全面检测中发现的**唯一一个用户可见的、必然触发的功能缺陷**。

## 决策

**把「地址自身的路径」从 URL 对象里取出来单独存，拼接时基于它而不是基于 `url.pathname`。**

```ts
  /**
   * The address's own path, without a trailing slash, and empty for a server
   * root. It is kept aside because a URL cannot hold that emptiness: assigning
   * `''` to a pathname puts the `/` straight back, and joining onto that `/`
   * would build `//dsh-webdav`, which servers answer 400 to.
   */
  private readonly basePath: string
```

构造函数在这一个地方算出它（`src/dav.ts:118-121`）：

```ts
    const path = parsed.pathname.replace(/\/+$/, '')
    parsed.pathname = path
    this.base = parsed
    this.basePath = path
```

`url()` 改成基于字段拼接（`src/dav.ts:137`）：

```ts
    url.pathname = `${this.basePath}/${parts.join('/')}`
```

对根地址 `basePath` 是 `''`，于是 `'' + '/' + 'dsh-webdav'` = `/dsh-webdav`，正是想要的；对 `/dav` 这种地址结果也不变。**一个表达式同时覆盖两种情形，不需要为根地址写特例。**

同一处拼接在 `nowhereMessage()` 里还有一份（`src/dav.ts:368`），用来给 OpenList/Alist 用户举一个「像这样的子目录地址」的例子。它**本来是对的**——它自己写了一遍 `child.pathname.replace(/\/+$/, '')`，先把 `/` 摘掉再加，恰好绕过了同一个坑。改动把它也换成 `this.basePath`，理由是「地址自身的路径」这个概念应该只有一个来源；`list()` 里 `const self = this.base.pathname.replace(/\/+$/, '')`（`src/dav.ts:441`）同理，那个 `replace` 在 `basePath` 上本来也是空操作。换句话说，这两处不是修 bug，是消除重复的定义。

**被否决的备选：**

1. **在 `url()` 里判断 `pathname === '/'` 时不要那个前导 `/`。** 能修好，但把「URL 对象的规范化行为」这个坑留在了原地；`nowhereMessage()` 那处同样的拼接漏掉就又是同一个 bug。存下 `basePath` 是把根因（无法用 URL 表达空路径）在一个地方解决掉。
2. **把 `base` 存成字符串而不是 `URL`。** 会丢掉 `new URL()` 已经做掉的协议校验、端口规范化、凭据处理，改动面也大得多。
3. **在保存配置时就禁止不带路径的地址**（`src/index.ts:143` 的 `next.url = body.url.trim().replace(/\/+$/, '')` 那里顺手校验）。等于把最常见的自建服务器形态排除在外，而且真正的毛病是拼接，不是输入。
4. **只加测试不改代码。** 双斜杠不是「服务器宽容一点就能过」的问题——WsgiDAV 直接 400，而 `check()` 又会把 400 说成正常，只加测试等于把这个缺陷固定下来。

**同时收紧 `check()`：不认识的状态不再算成功。**

```ts
    else if (folder.status >= 300) {
      // Anything else is a refusal this check cannot call success: a 400 here was
      // once reported as "the server answered" while every later sync failed.
      await drain(folder)
      throw new Error(
        `the WebDAV server answered ${folder.status} for the folder ${REMOTE_FOLDER} in ${displayPath(this.base)}: the address has to be a folder files can be written in`,
      )
    }
    await drain(folder)
    return { ok: true }
```

这一条是**独立于**双斜杠缺陷的：即使地址拼接以后不会再出错，把「未识别的状态」当成成功仍然是错的——它会把任何服务器端的拒绝都变成一句乐观的「服务器已应答」。两条一起修，是因为**正是这个静默才让双斜杠缺陷以「测试通过、同步失败」这种最难排查的形式出现**。修了拼接却留着静默，下次再有类似的 URL 问题，用户还是先看到「一切正常」。

顺带把 `check()` 里原本没有 `drain()` 的响应补上排空，避免连接无法复用。

## 影响

正面：

- 不带路径的地址（`https://dav.example.com`、`http://host:port`）现在可用，六种地址形态（根/根带斜杠/带路径/带路径带斜杠/带端口/带端口带斜杠）实测拼出的都是单斜杠。
- 「测试连接」不再会把一个必然失败的配置说成正常，失败时给出的是带状态码与路径的具体消息。
- 修的是根因（URL 无法表达空路径），「地址自身的路径」现在只有 `basePath` 一个来源，`url()`、`nowhereMessage()` 与 `list()` 三处都读它。
- 对原本就正确的带路径地址（坚果云等）行为完全不变，回归测试同时锁住这两类形态。

负面：

- `basePath` 与 `parsed.pathname` 是两个可以互相不一致的状态，靠构造函数里相邻的两行赋值维持同步。若将来有人绕过构造函数直接改 `base`，拼接就会与它脱节。（缓解：两者都是 `private readonly`，构造之外不可写。）
- `check()` 收紧后，某些确实能工作的服务器若对 `PROPFIND <地址>/dsh-webdav/` 回一个未识别的 3xx/4xx，会从「静默通过」变成「报错」。这是有意的取舍——把「不确定」报成「失败」比报成「成功」安全，但确实可能对畸形服务器更严格。
- 双斜杠缺陷**在被发现前已经存在于已发布版本里**，所以早先以根地址配置过的用户可能已经见过「测试连接成功但同步失败」。修复不能追溯，只能要求这些用户升级后重新点一次「测试连接」。

## 验证

- `tests/dav.spec.ts` 新增三例：根地址（4 种写法）不得出现双斜杠、带路径地址（3 种写法）拼装不变、`check()` 遇到 400 必须报错而不是通过（`folderProbeStatus` 这一新的 `FakeDav` 选项模拟「服务器拒绝它无法解析的路径」）。
- `tests/fake-dav.ts` 新增 `folderProbeStatus?: number`：让「集合不存在时 PROPFIND 回什么」可配置，默认仍是 404。
- 全量 `pnpm test` 从 153 例增至 156 例，全通过。
- 真实 WsgiDAV 复测：`check` → `PROPFIND /` 207、`PROPFIND /dsh-webdav/` 404、`MKCOL /dsh-webdav/` 201、`HEAD`/`PROPFIND` 404；`preview` → 200；`sync` → `PUT` 201 且回读校验通过。

参考 [0007](0007-never-silently-overwrite.md)（同样是「不认识的服务器行为必须先停下来说清楚」的立场）。
