# 0063 — 保留模型清单里 provider 的顺序

状态：`已接受`

## 背景

同步比较两边的 `models` 份时用的是 `hashJson`，而它对对象键排序——两台电脑的 `config.providers` 只要路由相同、顺序不同，哈希就一样，同步会报告「两边一致」。但 DSH 读模型清单时是按 `config.providers` 这个映射自身的顺序走的（`resolveProfiles` 逐项 `Object.entries` 注册路由，设置目录也按这个顺序列出模型），所以「把某个 provider 挪到最上面」是一个人真实的配置改动，不该被同步吞掉。反过来，一次无害的重新序列化（键的顺序在 YAML 里本来就不该有意义）也不该因此触发一场假同步。

此前工作树里 modelsIdentity 相关改动已经写好并带测试，但决策记录缺位，且 `src/store.ts` 注释引用的 `docs/decisions/0063-keep-provider-order.md` 尚不存在。

## 决策

比较与哈希 `models` 份时，不直接用原对象，而是先经过 `modelsIdentity`：把 `config.providers` 从映射换成 `[name, route]` 对的**数组**再交给 `hashJson`——对象键会被排序抹平，数组保序，于是「provider 挪动」成为可感知的改动；其余键（模型行本体）仍按对象比较，无意的重排格式依旧不算变化。

合并方向跟随「谁的清单变了」：本机清单里 provider 的顺序变了，就把文件里 `providers` 映射的键序按本机重排（`reorderProviders` 直接移动 YAML 的 `Pair` 节点而非重建，注释跟着条目走）；远端变了则反向。只新增对象（同序新建的映射）不触发任何写入——文件保持逐字节稳定。

## 影响

- 正面：在 A 上把 provider 挪前挪后并同步，B 会得到同样的顺序；设置页里的模型列表从此不再「同步了但顺序没跟过来」。
- 正面：`applyPatch` 的字节稳定检查继续成立——顺序没变时文件一个字节不动。
- 代价：`providers` 的键序从此是同步契约的一部分；手工大幅重排 YAML 键序会触发一次真同步（把键序排回去），属于「把配置当真」的延伸而非回归。
- 测试：`tests/store.spec.ts` 的「the model catalog order」一组用例覆盖逆序写入、纯新建对象不写盘、provider 与其上方注释一起移动。
