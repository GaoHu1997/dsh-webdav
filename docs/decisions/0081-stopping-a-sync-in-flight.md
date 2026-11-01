# 0081 — 「关闭同步」立即取消在途同步，不再被运行中的动作挡在门外

- 状态：已接受
- 日期：2026-11-01
- 范围：宿主 `turnOff` 与 `sync`/`restore`/`upload`/`undo` 的取消检查点、卡片 `stop()` 路径与两个被 `busy` 挡住的控件；改动浏览器产物与宿主产物，不升级 `version`。

## 背景

用户报了两件看起来无关、实际是同一处设计的事：

1. **点「停止同步」没有反应。** 卡片上的「停止同步」就是「关闭同步」（`autoOff`）。同步进行中 `state.busy === 'sync'`，而自动同步那一行的 `SegmentedControl` 与确认框的「确定」都写成 `disabled={busy}`，于是点击既不触发也不给任何反馈。即便绕过禁用触发，`card-store.ts` 的 `run()` 第一行 `if (this.state.busy !== '') return false` 会静默丢弃这次动作——而 `answer()` 已经先把 `confirm` 清空，用户看到的就是「确认框消失、什么都没发生」。现场证据与之吻合：用户点过之后 `~/.dsh/profiles/desktop/.dsh-webdav-sync/sync.json` 的 mtime 仍是几天前，说明 `/off` 路由根本没有执行（`turnOff` → `saveConfig` 本会写这个文件）。

2. **点了手动同步，后台还有逻辑在处理。** 宿主 `turnOff()` 只把 `url`/`password` 从配置里清掉，既不取消正在跑的 `sync()`，也不进 `serially` 队列——已经发出的那次同步会继续写本机文件、继续 push 服务器。前端 `ACTION_TIMEOUT_MS = 10 * 60_000` 到点只是「放弃等待」，宿主那边照旧跑完。

「关闭」在用户心里是「现在就停」，代码里却是「下次别再开始」。这两个语义混在一起，才有了上面两条。

## 决策

### 1. 宿主用代次（epoch）取消在途同步，关闭同步是硬停止

`src/engine.ts` 增加模块级 `let stopEpoch = 0`、`export class SyncStoppedError`、`export function stopRunningSyncs()`（`stopEpoch += 1`）与 `function checkpoint(epoch)`（`epoch !== stopEpoch` 时抛 `SyncStoppedError`）。

- `turnOff()` 的**第一行**就是 `stopRunningSyncs()`：停止要先于「等一下正在跑的同步」发生，所以它不进 `serially`。
- `sync()` 在进入 `guarded()` **之前**取 `const epoch = stopEpoch`，因此连排队等 `serially` 的那些 `sync()` 也会在轮到自己时立刻被取消，而不是等前一个跑完再跑。
- 检查点放在真正会写东西的地方：`guarded` 入口、`ensureStateDir`/`freshState` 之后、`syncOnce` 的每次 `openRemote` 之后、服务器为空时 push 之前、冲突副本 / `keepUnmerged` 落盘之前、`mergedHashes` 之前、以及写 `state.last` 之前。最后那个检查点让「被取消的那次」不算成一次成功尝试。
- `guarded()` 的 catch 对 `SyncStoppedError` 跳过 `recordFailure()`：用户主动停止不是失败，不该在卡片上留一句红色的「上次同步失败」。
- `restore` / `upload` / `undo` 同样在 `guarded()` 之前取 `epoch` 并在入口检查，避免「关闭同步后，排队中的写操作接着执行」。

### 2. 前端把「关闭同步」从互斥里拿出来，并让迟到结果作废

`src/client/card-store.ts` 新增 `private epoch = 0` 与 `private async stop()`：

- `stop()` 不经过 `run()`，所以不被 `busy` 互斥挡住；它自己 `++this.epoch`，把 `busy` 置为 `'off'`、清掉 `confirm`/`preview`/`dirty`/`message`，再发 `requestOff()`。
- `run()` 在拿到 `answer` 之后比对 epoch，不一致就返回 `false` 且不动任何状态——那次被取消的同步回来时，不能把卡片重新画成「正在同步」，也不能用自己的 message 盖掉「已关闭」。
- `answer(true)` 的 `off` 分支改为 `void this.stop()`（`answer()` 仍先清 `confirm`，但现在后面确实有动作跟上）。

`src/client/WebdavSyncCard.tsx` 里两个被 `busy` 挡住的控件改成 `disabled={state.busy === 'off'}`：自动同步的 `SegmentedControl` 与那个确认框的「确定」。只在这一种确认上放开——其它动作在 `off` 进行中仍然该挡住，而 `off` 自己进行中也不该被重复点。其余六个动作按钮保持 `disabled={busy}`：它们没有「用户等不下去」这个压力。`BUSY_TEXT` 补上 `off: 'autoOff'`，于是关闭的过程中也会显示「关闭同步 正在处理…」，而不是一键下去毫无回声。

### 3. 否决的备选

- **只把 `disabled` 放开。** 不够：`run()` 的 `busy` 互斥照旧静默丢弃，用户会得到和现在一样的「点了没反应」。
- **用 `AbortController` 贯穿 `dav` 的每个请求。** 改动面大得多（每个调用点要传 signal），而 `turnOff()` 拿不到在途请求的 controller，还得引入一张全局表；`dav` 本身已有 `AbortSignal.timeout(120s)` 兜底，取消靠检查点已经够用。
- **让 `turnOff()` 排进 `serially` 等同步跑完再关。** 用户点「停止」正是因为它跑不完，排队等于把问题原样还给他。
- **在卡片上把「关闭」改名叫「关闭同步（需要等当前同步结束）」。** 那是把设计的短板写成说明文字，且没有解决后台继续在写的问题。

## 影响

正面：

- 「关闭同步」名副其实：在途同步在下一个检查点停下，不再继续写本机或 push。
- 被取消的那次同步不写 `state.last`、不写 `error`，卡片不会因此显示一次虚假的失败或一次虚假的成功。
- 迟到的同步结果不会覆盖「已关闭」这个状态，用户看到的结果与最后点击的动作一致。
- 两个原本「点了没反应」的控件现在在同步进行中也可以用。

负面与边界：

- 取消是检查点式的，不是逐字节中断：两次检查点之间已经完成的写无法撤回；如果一次同步已经 push 成功，关闭也回滚不了服务器上的那份文件。
- 不改变「手动同步」选项卡只改草稿、需在底部「保存」才生效的既有设计（`setAuto` → `dirty: true`）；定时器在保存前仍按原来的 `autoEvery` 走。这一点在答复里向用户说明，不在本次改动范围内。
- 新增一个对外错误类型 `SyncStoppedError`；宿主日志里它会以普通异常出现，调用方若把它当失败显示需要注意。
- `stopEpoch` 是模块级全局计数，同一个宿主进程内所有 engine 共用——这正是想要的（关闭是全局动作），但它也意味着一个失败/重启的实例不会自动恢复旧的 epoch，需要重新 `sync()`。

## 验证

- 新增 `tests/client-card.spec.ts`「turns off while a sync is still running, and the late sync does not win」：同步在飞行中被关闭，`/off` 仍发出，迟到的同步不改 `busy` 也不改 `message`。
- 新增 `tests/engine.spec.ts`「cancels a sync that is still running when sync is turned off」：第一个请求被扣住时 `turnOff()`，在途 `sync()` 抛 `SyncStoppedError`，`state` 的 `last`/`error` 都没有被写，服务器上也没有出现文件。
- `pnpm run typecheck`、`pnpm run build`、`pnpm test` 全绿（详见提交说明）。
