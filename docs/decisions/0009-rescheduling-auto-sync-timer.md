# 0009 — 自动同步用定时器：每次 tick 重读配置，`autoEvery` 默认手动

- 状态：已接受
- 日期：2026-10-16（本仓库首次提交）

## 背景

同步这件事有两种时间尺度：用户坐在卡片前按一下，和用户在别的机器上改了东西、希望这台机器自己跟上。

第二件事需要自动执行，而 Host 半边在插件加载时就已经在跑了（DSH 启动的那一刻），此时用户可能还没打开过任何界面、甚至还没填过地址。于是有几个必须回答的问题：

- **什么时候开始？** 插件加载时 `sync.json` 可能还不存在，或者存在但 `url` 是空的。
- **隔多久一次？** 用户改了这个设置之后，要不要重启 DSH？
- **失败了怎么办？** 网络断了、口令错、服务器 429——下一次还要不要再来。
- **插件被卸载/停用呢？** 定时器不能留着。
- **和用户手动按的那次会不会撞车？**

还有一个环境事实：DSH 的插件生命周期由 cordis 管理，`apply()` 返回之后插件仍然活着，所以定时器必须挂在能被宿主回收的 effect 上，而不是一个裸的 `setInterval`。

## 决策

**配置项 `autoEvery`，默认 `-1`（手动）。**

```ts
export const AUTO_MANUAL = -1
/** The intervals the card offers, in minutes. */
export const AUTO_CHOICES: readonly number[] = [AUTO_MANUAL, 3, 15, 30, 60]
```

（`src/wire.ts:239-241`；`defaultConfig()` 里 `autoEvery: AUTO_MANUAL`，`src/state.ts`。）取值只接受这五个：`normaliseConfig` 在读取时把不合法的值折回 `AUTO_MANUAL`，`configure()` 在写入时忽略不在 `AUTO_CHOICES` 里的数（`src/index.ts:152-154`），`validateConfig` 在组合层同样只接受这五个。

**默认手动**是刻意的：自动同步意味着「后台会替你改 profile 文件」，这个决定应该由用户显式做出，而不是装上插件就开始。

**每次 tick 都重读配置，而不是把间隔捕获一次**（`src/index.ts:336-356`）：

```ts
  const tick = async (): Promise<void> => {
    if (stopped) return
    let wait = 0
    try {
      const paths = resolveFromEnv(readVolatile(currentConfig().profileDir))
      const { config: stored } = await loadConfig(paths)
      const minutes = stored.autoEvery
      if (usable(stored) && minutes > 0) {
        await sync(engineFor(paths, stored)).catch(() => undefined)
        wait = minutes * 60_000
      }
    } catch {
      // ...
    }
    if (stopped) return
    // Nothing to do is polled for slowly instead of not at all, so turning sync
    // on in the card starts it without a reload.
    timer = setTimeout(() => void tick(), wait === 0 ? 60_000 : wait)
    timer.unref?.()
  }
```

四个要点：

1. **间隔是「上次尝试之后」而不是固定周期**。一次耗时很长的同步（大文件、慢服务器）不会叠上下一次。
2. **没事可做时按 60 秒轮询，而不是干脆不排下一次**（`wait === 0 ? 60_000 : wait`）。注释说明了原因：卡片里刚打开同步、配置刚写进 `sync.json`，下一个 tick 就会重新读到并开始工作——**不需要重启 DSH，也不需要通知定时器**。这是「重读配置」这条规则真正的用处。
3. **首次等待 20 秒**（`FIRST_DELAY_MS = 20_000`，`src/index.ts:72`），不是立刻。DSH 刚启动时 profile 可能还在被写、网络栈可能还没就绪，过早跑一次同步只会失败并写下一条 `error`。
4. **失败不特殊处理**：`sync(...).catch(() => undefined)`——失败由 `sync` 自己记进 `state.error`（见 [0011](0011-state-key-isolation.md)），定时器只负责按 `minutes` 排下一次。一条注释明说了这是刻意的：*the next tick tries again, which is the whole point of a timer.*

**定时器是不被引用的，并且挂在一个 effect 上**：

```ts
  timer = setTimeout(() => void tick(), FIRST_DELAY_MS)
  timer.unref?.()
  ctx.effect(() => () => { stopped = true; if (timer !== undefined) clearTimeout(timer) }, 'webdav-sync: auto-sync timer')
```

`unref()` 让这个待触发的定时器**不阻止 Node 退出**——一个后台轮询不该让 `dsh` 进程关不掉。`ctx.effect` 保证插件被卸载时定时器被清掉，`stopped` 标志保证一个已经在飞的 tick 不会在清理之后再排一次。

**与手动同步的竞争由进程内的串行队列处理。** `src/engine.ts:99-110` 的模块级 `queue` + `serially()` 把所有操作串起来；注释里解释了为什么必须有它：

```
 * the state file is read, decided and written with no lock of its own, so two
 * syncs running together would each merge against a state the other is about to
 * replace. They queue here instead. Two DSH windows at once are a different
 * matter, and are caught by the ETag check on the write.
```

也就是说：**同进程内**（定时器 vs 卡片按钮 vs 两个标签页）靠队列，**跨进程**（两个 DSH 窗口）靠写入时的 `If-Match`。

**自动同步不装插件。** 定时器调用的是 `sync()`，而 `installPlugins()` 只有 `/install` 路由会触发（见 [0004](0004-single-remote-file.md)）。后台跑 `pnpm install` 意味着在用户不知情时改 `node_modules` 并执行包的生命周期脚本，这条线不越。

## 影响

正面：

- 改了间隔立刻生效，不需要重载界面或重启 DSH——用户感觉「设置是活的」。
- 默认不自动，装上插件不会在后台改 profile。
- 「什么都没配也轮询」让「先填地址、后开自动」这个顺序也不出问题。
- `unref()` + `ctx.effect` 让插件不阻碍进程退出、也不留悬空定时器。
- 串行队列消除了同进程内的状态竞争，同时让卡片按钮和定时器共用一个实现（都走 `sync()`）。

负面：

- **60 秒的轮询在什么都没配的时候也一直在跑**（每 60 秒读一次 `sync.json` + 一次 `resolveFromEnv`）。代价很小但确实存在，而且它只在 DSH 进程活着的时候跑。
- **写入仍然是「最后写者赢」的跨进程语义**：两个 DSH 窗口同时自动同步，只有 ETag 检查能挡住第二个，第二个会拿到 `ChangedError`——没有任何重试或退避，它就是把错误记下来等下一位。
- **`429` 的等待没有反馈到定时器**。`dav.ts` 的 `RateLimitedError` 带着 `Retry-After`，但 `startTimer` 排下一次的间隔只由 `autoEvery` 决定；`Retry-After` 的语义只在错误消息里告诉用户「下次会等更久」。用户把间隔设成 3 分钟、服务器要求等 10 分钟时，代码不会自己退避。
- **两个 `autoEvery` 容易混淆**：组合层的 `Config`（`cordis.patch.yml` 的字段，有 `z.number().default(-1).volatile()`）与存在 `sync.json` 里的 `SyncConfig.autoEvery` 是两个不同的东西，而 `startTimer` 只读后者。前者只被 `validateConfig` 用来校验，改它不影响任何定时行为。
- 定时器的 `catch {}` 完全静默（注释说「配置还读不出来不算错误」），所以一个持续失败的配置只会在卡片上显示最近一次的错误，没有跨次的历史。
