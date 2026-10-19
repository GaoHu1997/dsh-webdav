# 0018 写操作排队，一次只跑一个

- 状态：已接受
- 日期：2026-10-16

## 背景

`src/engine.ts` 里一直有一个进程内队列：

```ts
const queue: Promise<unknown> = { ... }
function serially<T>(work: () => Promise<T>): Promise<T> { ... }
```

注释说它是为了让一次失败不卡死后面的动作。问题是没有任何调用点——四个会改状态的入口 `sync`、`restore`、`upload`、`undo` 全都直接跑。

没有队列时的具体后果：`applyMerged()` 通过 `writeAtomic()` 写临时文件再 rename。两个动作同时进来时，一个会把另一个的临时文件换走，另一个再 rename 就撞上 `EPERM`（Windows 上尤其容易，因为目标文件被短暂占用）。更麻烦的是状态文件：两个动作各自读到了对方的旧状态，谁后写谁赢，基线就成了两者之间的某个混合值。

DSH 的一个进程里可能同时跑两个插件实例（两个设置窗口的 Host），所以这不是纯理论问题。

## 决策

四个写操作全部走同一个队列，并且把"记录失败"放进同一个队列轮次里，避免状态文件被两个动作交叉写：

```ts
function guarded<T>(engine: Engine, work: () => Promise<T>): Promise<T> {
  return serially(async () => {
    try {
      return await work()
    } catch (cause) {
      await recordFailure(engine, cause)
      throw cause
    }
  })
}
```

排队的不是单个文件写，而是整个"读—判断—写"的周期。文件级的原子性只保证字节不撕裂，队列保证的是两个动作不会各自拿着半个世界去改。

## 影响

正面：并发 `sync()` 不再争抢临时文件；状态文件的写入顺序就是动作的顺序。

负面：一次同步在进行时，第二次要排队等它。正常的 UI 用法下这正是想要的——用户看到的是"正在同步"而不是两个进度条互相覆盖。HTTP 路由不因此排队：`src/index.ts` 仍然立即返回，卡片自己处理忙碌态。

被否决的备选：
- **给 `writeAtomic()` 加锁**。锁能防住 rename 撞车，但防不住状态基线被交叉写，两个动作的合并结果仍然是错的。
- **给整个 `Engine` 加互斥**。等价于队列但要把锁带进每个方法签名，队列已经是模块级的，不需要。

## 相关

- `docs/decisions/0017-blind-write-baseline-guard.md` —— 排队之后，基线只由一条顺序链改写。
- `docs/decisions/0009-rescheduling-auto-sync-timer.md` —— 自动同步 tick 会重读配置，但仍然进同一条队列。
