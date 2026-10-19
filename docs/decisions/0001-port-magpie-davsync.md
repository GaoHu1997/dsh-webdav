# 0001 — 移植 magpie 的 davsync 设计，用分片三方合并

- 状态：已接受
- 日期：2026-10-16（本仓库首次提交）

## 背景

把一台电脑上的 DSH 配置搬到另一台，需要一个能落地的载体。可选的对端协议很多（WebDAV、S3、Git 仓库），但没有一个「DSH 配置同步」的既有实现可以直接用：DSH 的配置是 profile 目录里的 `cordis.patch.yml`（一个 loader 行的 YAML 顶层数组）与 `package.json`（已安装插件清单），两者的结构都是项目自己的约定。

真正要先定的是**同步语义**，不是传输协议：

- 两台电脑都在改。只做「整文件覆盖」的话，谁最后按按钮谁赢，另一台电脑上同样的改动就白做了。
- 只做「逐文件镜像」的话，profile 目录里还放着状态、缓存、构建产物，镜像整个目录既不现实也不安全。
- 用户希望同步是「无冲突」的日常动作，而不是一个需要人先 `pull` 再手解的版本控制流程。

[magpie](https://github.com/yetone/magpie) 的 `internal/davsync` 已经解过同一道题：它的配置要经 WebDAV 在多台机器之间保持一致，用的就是「服务端只存一份密封文件 + 按分片三方合并」。这是一份经过实际使用检验的设计，且有 Magpie 这个真实项目在跑。

被否决的备选：

- **整文件覆盖（last-write-wins）**：实现最简单，但会把另一台电脑未上传的改动直接丢掉，且丢得毫无痕迹。
- **逐文件镜像（rsync 式）**：冲突面从一个文件变成每个文件，且需要一套删除检测；profile 目录里还有大量不该同步的内容。
- **换成 Git 仓库做后端**：需要用户理解分支与合并，且引入了 `.git` 目录、提交历史与冲突标记——对一个「多点几下就好」的设置页太重。
- **自研一套 JSON 配置的 diff/patch**：DSH 的 patch 是 YAML 且带注释，自己写 diff 很快会遇到「注释/引号在往返中丢失」的问题。

## 决策

以 magpie 的 `internal/davsync` 为蓝本，把配置切分成若干**分片（part）**，每片单独哈希，一次同步就是**每片一次的三方合并**：

- 三方是：本机现在、服务器现在、上次同步留下的基线（`state.local` / `state.remote`）。
- 只本机改动的分片推上去；只在服务器改动的取回来；两边都改动的保留较新的一份，另一份留档。
- 服务器上始终只存**整个 setup 的一个版本**（`Bundle`），而不是 profile 的镜像。

设计来源写在 `src/engine.ts` 的文件头注释里，作为后来者的入口：

```
 * The design comes from magpie's `internal/davsync`. The setup travels in parts,
 * each hashed on its own, and one sync is a three-way merge per part between what
 * the server last held, what it holds now, and what is here.
```

移植中做了三处适配：

1. **Go → TypeScript**：没有常驻服务，一次同步就是几次 HTTP 往返加几次文件读写；进程内用 `serially()` 排队（`src/engine.ts:99-110`），跨进程靠 ETag 条件写。
2. **同步对象改成 DSH 的 profile 行**：`cordis.patch.yml` 的 loader 行与 profile 的 `package.json`。因此多了 `src/store.ts` 这一层——用 `yaml` 的 Document API 做文档级合并而不是「解析成对象再序列化」，以保住用户的注释、缩进和引号风格。
3. **对象存储省略 `node_modules`**：只同步声明，包在本机用 pnpm 重新拉（见 [0004](0004-single-remote-file.md)）。

保留的 magpie 特性：一份文件而不是镜像、按分片哈希、新者胜并把败者留档、写入带版本条件（`If-Match`）以免静默覆盖另一台电脑的写。

## 影响

正面：

- 两台电脑各改各的也能收敛，不需要人先解冲突；常见情形（只有一边改过）是无冲突的。
- 分片粒度让「只改了默认模型」的同步不会拖着整个模型目录一起走：`hashesOf` 逐片算 canonical JSON（对象 key 排序）的 SHA-256（`src/engine.ts:992-1000`、`src/crypto.ts:172-191`），所以 YAML 里 key 的书写顺序变化不会造成假变更。
- 合并单位是「整个 setup 的一个版本」而不是单个文件，服务端不存在半个 setup 被读到的可能。

负面：

- 分片粒度是固定的四份（见 [0005](0005-four-parts-and-plugin-exception.md)）。同一个分片内两台电脑各改一处仍然算冲突，会走「新者胜」，被覆盖的那一份只能从 `sync/` 目录里人工找回。
- 引入了一个不属于本项目的概念依赖：magpie 的取舍（比如「新者胜」而非逐字段合并）在这里被整体继承，后续若要偏离就得先意识到偏离。
- 移植带来了 magpie 所面对的服务器差异问题，`src/dav.ts` 里为此写下了 坚果云 409、Synology 403、OpenList/Alist 的 `/dav/` 等一整套方言处理——这是设计移植的附带成本。
