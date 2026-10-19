# 0023 没有 id 的 `insert:` 块按内容取身份

- 状态：已接受
- 日期：2026-10-16

## 背景

`cordis.patch.yml` 里的 patch 行靠一个身份键来认："这一行上次是哪一行"。`keyOf()` 原来的规则是：

- 有 `id` → `id:<id>`；
- 是 `insert:` 块 → 把里面每行的 id 拼起来，缺一个就算 `?`，得到 `insert:<ids>`。

问题出在 `?` 上。两块都声明了行却没有行的 `id` 时：

```yaml
- insert:
    - name: alpha
- insert:
    - name: beta
```

两块都得到 `insert:?`。合并时第二块被当成第一块，于是第二块里的 `beta` 不见了，或者第一块被第二块整个盖掉。服务器上也可能已经有这两块，合起来的机器会把它们互相吞掉。

ADR 0005 说 patch 是一份镜像、删除会传播。这个问题不属于那个范畴——这是两个不同的东西被当成了同一个，那才是丢失。

## 决策

只有当 `insert:` 块里每一行都有非空字符串 `id` 时，才用 id 列表做身份键。只要有一行匿名，就退回按整块内容取键：

```ts
function keyOf(entry: PatchEntry): string {
  if (typeof entry.id === 'string' && entry.id !== '') return `id:${entry.id}`
  if (Array.isArray(entry.insert)) {
    const ids = entry.insert.map((row) => (
      isPlainObject(row) && typeof (row as { id?: unknown }).id === 'string' && (row as { id: string }).id !== ''
        ? (row as { id: string }).id
        : undefined
    ))
    if (ids.every((id) => id !== undefined)) return `insert:${ids.join(',')}`
  }
  return `row:${hashJson(entry)}`
}
```

`hashJson` 走的是 `stableJson`，键会递归排序，所以同一块内容在不同机器、不同文件顺序下算出同一个哈希。内容相同的两块仍然被当成同一行（合并后不会重复），内容不同的两块必然分开。

匿名块还有一层好处：块的内容变了，它在合并里就不再匹配自己上一次的样子，于是新内容被追加下去而不是原地改——对手写 `insert:` 块来说这是更安全的方向，因为插件无法猜出用户想把哪一行改名。

## 影响

正面：两块匿名 `insert:` 块不再互相覆盖；同步后两个块都在。

负面：一块匿名 `insert:` 块每次内容变动都会在 `cordis.patch.yml` 里多留一份旧内容。`insert:` 的语义本来就是"加进去"而不是"改写"，而插件对匿名块也无法判断哪一行是同一行。更保守的代价是 YAML 会稍微变长，ADR 0006 的 `sync/` 留档也照常可用。

被否决的备选：
- **给匿名行编一个序号**（`insert:0`、`insert:1`）。序号只在这一次解析里有意义，两台机器上同一份文件的行序可能不同，会造成假的"两边都改了"。
- **要求 `insert:` 块必须有 id**。可以在界面上提示，但插件无权拒绝一个合法的 YAML 文件。
- **按行内容逐行取键**。块是插件的合并单位，按行匹配会让一次块内编辑看起来像"删了旧的、加了新的"。

## 相关

- `docs/decisions/0005-four-parts-and-plugin-exception.md` —— patch 是镜像。
- `docs/decisions/0020-apply-patch-without-config-key.md` —— 合并时对不完整的行更宽容。
