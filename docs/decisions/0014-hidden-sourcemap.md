# 0014 — 浏览器 bundle 用 `sourcemap: 'hidden'`：不发布指向不存在文件的注释

- 状态：已接受
- 日期：2026-10-16（全面检测阶段发现并修复）

## 背景

`package.json` 的 `files` 里有一条排除：

```json
  "files": [
    "lib",
    "!lib/**/*.map",
```

即**构建产物里的 sourcemap 不进 npm 包**。理由是这个包发布的是 `lib/`（tsc 产出的 host 半边 + tsdown 产出的浏览器半边），而 `.map` 文件让 tarball 从 26 条涨到近 30 条、体积翻倍，而它对**使用者**没有价值（它映射的是发布者的 `src/`，安装者不会去调试它）。这是有意的取舍。

问题在于 `tsdown.config.ts` 当时写的是：

```ts
  sourcemap: true,
```

`true` 的意思是「生成 map **并且**在产物末尾写一行 `//# sourceMappingURL=client.js.map`」。于是出现了一个自相矛盾的发布物：

- tarball 里**有** `lib/client.js`，末尾写着 `//# sourceMappingURL=client.js.map`（`lib/client.js:1203`）；
- tarball 里**没有** `lib/client.js.map`（被 `files` 排除了）。

实测确认：`pnpm pack` 后解包，`package/lib/` 下有 19 个文件，`client.js` 在，`client.js.map` 不在。用 `Select-String` 数 `sourceMappingURL` 的出现次数是 1。

Host 半边（tsc 产出）没有这个问题——`tsconfig.json` 没开 `sourceMap`，所以 host 的 `.js` 里 `sourceMappingURL` 出现次数是 0。

**实际危害有限但确实存在**：浏览器的 DevTools 只有在用户主动打开开发者工具、且该 bundle 被加载时才会去取那个 URL，取不到就在 console 里留一条 404（从 DSH Web 服务的 `/plugin/...` 路径下请求）。它不会影响功能，但它是一条**发布物自己的矛盾**：一个文件声称旁边有另一个文件，而 packaging 规则特意不让那个文件存在。

## 决策

**用 `hidden`，让 map 只为本地构建服务，不在产物里留下指向它的注释。**

```ts
  clean: false,
  // The map is written, but the bundle carries no `sourceMappingURL` for it:
  // `files` in package.json keeps `lib/**/*.map` out of the published tarball, so
  // a comment pointing at one would dangle in every installed copy. `hidden`
  // gives the local build its map and the release nothing to miss.
  sourcemap: 'hidden',
```

`tsdown` 的 `Sourcemap` 类型是 `boolean | "inline" | "hidden"`（`node_modules/tsdown/dist/types-BMMC0pbr.d.mts:157`），正是为这个场景准备的：`"hidden"` 生成 map 文件但**不**写 `sourceMappingURL` 注释。本地开发时 map 仍在 `lib/client.js.map`（DevTools 可以用它），发布时 tarball 里两者都没有。

**被否决的备选：**

1. **`sourcemap: false`。** 发布物干净了，但本地开发时也没有 map 了。改成 `'hidden'` 两种情形都照顾到，代价为零。
2. **把 `!lib/**/*.map` 从 `files` 里去掉，让 map 进 tarball。** 发布物自洽了，但每个安装者都要多下 84 kB 而且用不到——为了一条 404 提示付这个体积不划算。
3. **保留 `sourcemap: true`，接受那条 404。** 功能性无害，但这是一条**每个安装者都能在 console 里看到**的自家矛盾，而被发现的成本只是构建配置里的一个词。
4. **在 `files` 里改成精确列出要发布的文件而不是用排除法。** 更明确，但 `files` 的写法本身不是问题所在——问题是有个生成物在往里写一个「我旁边有 map」的注释，而注释是生成器决定的，不是 `files` 决定的。

## 影响

正面：

- 发布的 bundle 里不再有指向不存在文件的注释，安装者的 DevTools 不会为此发请求。
- 本地构建仍然产出 `lib/client.js.map`（83 kB），`pnpm run build:all` 的输出里照常列出它，调试体验不变。
- 构建配置与 `files` 的意图现在一致了：map 是**构建中间物**，不是发布物的一部分。

负面：

- 本地构建出的 `lib/client.js` 与发布出去的那份**在末尾差一行注释**，严格来说 `lib/` 不再逐字节等于 tarball 里的 `lib/`。（这是「发布物干净」必然的代价；host 半边本来就已经是这样——tsc 的产物与 tarball 一致，但那是巧合，不是保证。）
- 谁要是想调试**已安装**的那份 bundle（比如复现用户报告的问题），拿不到 map 了。这是刻意的取舍——包发布的是给 dsh 用的 loader bundle，不是给第三方调试的库。
- `sourcemap: 'hidden'` 是 tsdown 特有的取值（它透传给 rolldown）。如果将来换构建工具，这个取值要重新确认语义。

## 验证

- `pnpm run build:all` 后 `Select-String -Path lib\client.js -Pattern "sourceMappingURL"` 计数为 **0**（修复前为 1），同时 `Test-Path lib\client.js.map` 仍为 **True**，`lib/client.js.map` 83.27 kB 照常生成。
- `pnpm pack` 解包后复核 tarball 内容仍不含 `*.map`，且 `client.js` 中无 `sourceMappingURL`。
- 全量 `pnpm test` 156 例通过（构建配置不影响测试，此项只为确认没有连带破坏）。

参考 [0003](0003-secrets-in-state-file.md)（同为「什么东西不该离开开发者的机器」这一族决定）。
