# 0013 — `pendingInstall` 带上缺哪些包，而不只是一个布尔

- 状态：已接受
- 日期：2026-10-16（全面检测阶段发现并修复）

## 背景

`plugins` 这一份同步的是 profile `package.json` 里的 `dependencies` 与 `dsh.profile.bundles`，而 `node_modules` **不同步**（见 [0004](0004-single-remote-file.md)）。所以会出现一个正常且预期的中间状态：清单已经从服务器取回来了，但包还没在本机装。卡片要能说出这件事，并给一个按钮跑 `pnpm install`。

Host 半边为此算了一个布尔值：

```ts
async function pendings(engine: Engine, declared: PluginsPart | undefined): Promise<{ pendingInstall: boolean }> {
  if (!engine.config.plugins) return { pendingInstall: false }
  if (declared === undefined) return { pendingInstall: false }
  const installed = await installedPackages(engine.paths)
  return { pendingInstall: missingPlugins(declared, installed).length > 0 }
}
```

`missingPlugins()` 返回的是**包名数组**（已排序），但这里用 `.length > 0` 立刻把它压成了一个布尔；`StatusResult.pendingInstall`（`src/wire.ts:318`）与 `SyncResult.pendingInstall`（`src/wire.ts:354`）也都声明为 `boolean`。

界面这边的文案却是带占位符的（`src/client/locales.ts`）：

```ts
  pendingInstall: '有插件尚未安装：{names}',
```

而调用处只能硬塞一个空串（`src/client/WebdavSyncCard.tsx:285`，修复前）：

```tsx
          <span>{t('pendingInstall', { names: '' })}</span>{' '}
```

用户看到的是「**有插件尚未安装：**」——冒号后面什么都没有。这不是崩溃，但恰好是**最需要它说清楚**的那种提示：用户被告知缺东西，却不被告知缺什么，只能点「安装」去赌一次可能要跑几分钟的 `pnpm install`。

信息在 Host 半边**本来就有**，是在最后一步被丢掉的。

## 决策

**把包名一路带到界面，而不是在 `pendings()` 里压成布尔。**

`src/engine.ts` 的 `pendings()` 改成同时给出两者，且 `pendingNames` **只在 `pendingInstall` 为真时出现**：

```ts
async function pendings(
  engine: Engine,
  declared: PluginsPart | undefined,
): Promise<{ pendingInstall: boolean; pendingNames?: string[] }> {
  if (!engine.config.plugins) return { pendingInstall: false }
  if (declared === undefined) return { pendingInstall: false }
  const installed = await installedPackages(engine.paths)
  const missing = missingPlugins(declared, installed)
  // The names travel with the flag: the card says "these are not installed yet",
  // and a bare true would leave it naming nobody.
  return missing.length === 0 ? { pendingInstall: false } : { pendingInstall: true, pendingNames: missing }
}
```

`status()` 同理（`src/engine.ts:834-851`）——它原本在返回体里内联了同一个判断，现在先把结果算进一个 `missing` 变量，再同时回答两件事：

```ts
  const missing =
    config.plugins && plugins !== undefined
      ? missingPlugins(plugins, await installedPackages(paths).catch(() => []))
      : []
  ...
    pendingInstall: missing.length > 0,
    ...(missing.length > 0 ? { pendingNames: missing } : {}),
```

两个接口各加一个可选字段（`src/wire.ts`）：

```ts
  /** Which plugins those are, present exactly when {@link pendingInstall} is true. */
  pendingNames?: string[]
```

界面直接读它：

```tsx
          <span>{t('pendingInstall', { names: (state.view.pendingNames ?? []).join('、') })}</span>{' '}
```

**要点一：`pendingNames` 可选，而不是 `string[]` 恒存在。** 「没有缺包」与「缺包列表为空」是同一个意思，用两个字段表达会留下一个自相矛盾的状态（`pendingInstall: true` + `pendingNames: []`）。用 `...(missing.length > 0 ? {...} : {})` 展开保证了这个不变量在类型层面成立，`exactOptionalPropertyTypes` 也要求显式区分「不存在」与「是 undefined」。

**要点二：名字的**来源**是合并后的那一份。** `pendings()` 的注释原本就强调过：传进来的是 **merged** 的 `plugins`，不是本机合并前的。因为卡片问的是「现在加载这个 profile 需不需要装东西」，而从服务器刚带来的插件列表正是答案为「是」的典型情形。这一点没有变。

**要点三：`pendings()` 的四个调用点一个都不用改。** 它返回的对象是直接用 `...` 展开进 `SyncResult` 的（`src/engine.ts:225`、`:370`、`:527`、`:690`、`:784`），所以新字段自动跟着走。

**被否决的备选：**

1. **让界面在 `pendingInstall` 为真时自己再问一次 Host**（加一条路由或在 `status` 里另取）。多一次往返，而且答案在算出布尔的那一刻就已经在手里了，丢掉再取回来没有道理。
2. **把 `pendingNames` 做成恒存在的 `string[]`，空数组表示没有缺包。** 会引入上面说的那个矛盾状态；而且 `pendingInstall` 是既有字段，不能删（老界面/契约稳定性），两个字段就能互相打架。
3. **界面把 `{names}` 占位符整个去掉**，文案改成「有插件尚未安装」。改动最小，但等于承认这条提示永远说不出用户最想知道的事，而且丢掉的正是 Host 已经算好的信息。
4. **只改文案不改协议。** 同上；问题的根在协议字段太窄，不在文案。

## 影响

正面：

- 提示现在会列出真正的包名（多个用 `、` 连接），用户点「安装」之前就知道要装什么。
- 信息不再在 `pendings()` 的边界上被丢弃；`missingPlugins()` 的结果被完整使用。
- 既有调用点零改动（对象展开），`pendingInstall` 字段保持兼容，老界面仍可用。
- `pendingNames` 只在布尔为真时出现，避免了「说缺东西但列表为空」这种自相矛盾。

负面：

- 协议多了个可选字段，`StatusResult`/`SyncResult` 的消费者需要知道「`pendingInstall: true` 就一定伴随 `pendingNames`」。这不是类型系统能强制的不变量，只靠 `engine.ts` 里两处 `...(cond ? {...} : {})` 的写法维持；将来有人手写一个 `StatusResult` 就可能在类型正确的前提下违反它。
- 包名列表直接显示给用户，对 `@scope/name` 形式的长包名在小窗口里会换行，界面需要靠 CSS 兜住（`css.note` 已能换行，未专门处理）。
- 若缺包很多（清单来自一台装了二十个插件的机器），这一行会变得很长。当前没有折叠，因为真实使用中缺包通常是几个而不是几十个。

## 验证

- `tests/engine.spec.ts` 的「plugins that are declared but not installed」三例扩充：缺失时 `expect(result.pendingNames).toEqual(['dsh-git-branch-manage'])` 且 `status` 同样给出；已安装时 `expect(result.pendingNames).toBeUndefined()`；内置包（`@deepseek-ai/dsh-` 前缀）不计入缺失，故同样 `toBeUndefined()`。
- `pnpm run typecheck` 通过（`tsconfig.client.json` 覆盖 `src/client` 与 `src/wire.ts`）。
- 全量 `pnpm test` 156 例通过。

参考 [0005](0005-four-parts-and-plugin-exception.md)（`plugins` 这一份的特殊地位）与 [0004](0004-single-remote-file.md)（`node_modules` 为什么不跟着同步）。
