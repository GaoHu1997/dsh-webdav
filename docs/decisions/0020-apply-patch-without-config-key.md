# 0020 手写的行没有 `config:` 时按空配置合并

- 状态：已接受
- 日期：2026-10-16

## 背景

`cordis.patch.yml` 是人手写和工具写混在一起的。`llm-pi-ai` 和 `agent-default-model` 两行可以只有一行配置，也可以干脆只留个骨架：

```yaml
- id: llm-pi-ai
```

`applyPatch()` 合并到这一行时读 `existing.node.get('config', true)`。键不存在时 `yaml` 返回 `undefined`，接着进 `sameJson(undefined, part.config)`，`hashJson(undefined)` 在 `stableJson` 里对着 `undefined` 拼字符串，抛出一个原始的 `TypeError`。

用户看到的是一个从插件深处冒出来的 JS 异常，而不是"这一行和服务器上的不一样"。

## 决策

`applyPatch()` 先问键在不在：

```ts
const config = existing.node.has('config') ? existing.node.get('config', true) : undefined
if (config === undefined) {
  if (Object.keys(part.config).length > 0) existing.node.set('config', document.createNode(part.config))
} else if (!sameJson(config, part.config)) {
  existing.node.set('config', mergeInto(document, config, part.config))
}
```

三条含义：

1. 服务器那边**有**配置而本机这行是光杆 → 建一个 `config:` 节点填进去。
2. 服务器那边也是空的 → 什么都不写。不凭空多出一个空的 `config:`，那会让用户的文件和他写的不一样，下次同步又变成一次改动。
3. 两边都有 → 照旧递归合并，保留本机已有的排版和注释。

`mergeInto()` 也顺手防御 `undefined`/`null` 的来源节点，直接建新节点。

## 影响

正面：一份合法的 `cordis.patch.yml` 不再因为少写一行缩进就报 TypeError；合并出来的文件和手写的形状一致。

负面：多了一次 `has()` 查询，YAML 文档的代价可以忽略。

被否决的备选：
- **让 `hashJson(undefined)` 返回固定值**。那会把"没有这个键"和"这个键的值是 undefined"混成同一个哈希，而这两者在 YAML 里不是一回事；出问题的地方还会转移到别处。
- **`mergeInto` 里到处加 undefined 判断**。判断要加在该判断的地方，而不是每个递归入口。

## 相关

- `docs/decisions/0001-port-magpie-davsync.md` —— 四片分片的来源。
- `docs/decisions/0006-newer-wins-and-keep-aside.md` —— 合并结果不一致时的取舍。
