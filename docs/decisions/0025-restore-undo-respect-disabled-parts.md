# 0025 恢复和撤销都不写配置关掉的分片

- 状态：已接受
- 日期：2026-10-16

## 背景

配置里可以关掉某一片同步：`{ models: false }`，意思是不把 `llm-pi-ai` 那两行带过去也不带回来。

`syncOnce()` 的合并循环第一件事就是检查这个开关，注释写得很清楚："不携带"是这个指令，而一个写了它的动作就是无视这个指令。

`restore()` 和 `undo()` 都犯了同一个错：循环体先把服务器/备份里的分片填进 `merged` 和 `applied`，再判断开关，`continue` 跳过写入。由于 `applied[part]` 已经填上了，后面的 `applyMerged()` 照写不误。

结果是用户在配置里写了"这一片不要同步"，点了 Restore，发现它还是被改了——而 Restore 恰恰是最不该讲条件的一个动作：它的意思是"不管怎样，用服务器上的"。

## 决策

开关判断挪到循环体的第一行，和 `syncOnce()` 一致：

```ts
for (const part of PARTS) {
  // Restore does not weigh who changed what: every part that differs is
  // brought in, which is the whole point of the action.
  if (!syncsPart(config, part)) continue
  ...
}
```

`undo()` 里那段还多一句注释：撤销同样是一次对本机文件的写，所以关掉的片在这里也不动；备份副本里整份配置原样保留，需要的话可以手工去拿。

## 影响

正面：`{ patch: false }` 之下 Restore 和 Undo 都不会再碰 `cordis.patch.yml` 的 loader 行。配置关掉分片这件事在四个入口上行为一致了。

负面：想"一次性把某一片从服务器拉下来再关上"的人做不到，必须先开开关。这是显式的两步，而不是反过来。

被否决的备选：
- **在 `applyMerged()` 里统一过滤**。合并结果里本来就需要保留被关掉的片（ADR 0005：关掉的一片要原样上传给还在同步它的电脑），过滤点太靠后就分不清"不应用"和"不携带"。
- **让 Restore 忽略配置**。Restore 会让本机彻底变成服务器的样子，那时配置已经不是用户熟悉的那个了；而且这会让"关闭"这个设置在任何动作下都不成立。

## 相关

- `docs/decisions/0005-four-parts-and-plugin-exception.md` —— 关掉的分片仍然原样上传。
- `docs/decisions/0024-adopting-server-keeps-local.md` —— 接管前先留副本。
