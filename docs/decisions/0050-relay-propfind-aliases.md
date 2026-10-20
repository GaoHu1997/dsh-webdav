# 0050 — 持久化转发文件别名并在 PROPFIND 中还原 href

- 状态：`已接受`
- 日期：2026-10-20
- 相关：[0046](0046-relay-backup-file-extension.md)（为文件资源补 `.prop`）、[0044](0044-relay-propfind-collection-slash.md)（集合路径规范化）

## 背景

0046 为无扩展名的文件资源在上游路径末尾补 `.prop`，使受限客户端能上传，但上游 PROPFIND 返回的是实际存储名。例如客户端上传 `backup` 后，服务器列举 `/backup.prop`；部分客户端按该列表继续下载或检查，期待看到的仍是 `backup`，否则无法把备份识别为自己的资源。直接删除所有 `.prop` 后缀也不正确，因为用户可能原本就上传名为 `backup.prop` 的文件。

## 决策

- 将“客户端路径 -> 上游路径”的别名按上游 origin 与路径键入，持久化在当前 profile 的 relay stateDir。只在上游成功完成资源操作后记录；DELETE，以及显式 PUT 到真实 `.prop` 名称时清除对应旧别名。映射文件通过原子写入保存，RelayServer 停止时等待已排队的映射写入结束。
- 对成功的 `207 PROPFIND`，只流式改写 DAV `href` 元素：上游 href 精确匹配已知别名时恢复客户端原始路径，同时保留查询串、绝对/相对形式、XML 转义和其他响应字节。未知 href 与原生 `.prop` 路径保持不变。
- PROPFIND 请求携带 `Accept-Encoding: identity`；仅处理未压缩的 207 响应体。改写时移除失效的 `Content-Length`、`ETag`、`Content-MD5` 与 `Digest`，避免实体变更后头部不一致。无法解压的内容不尝试改写。
- 不用“所有 `.prop` 一律去后缀”的静态规则，也不把 XML 文档整体解析再序列化：持久别名能区分代理添加的后缀与原生文件名，流式局部改写则保留服务器 XML 的其他内容。

## 影响

- **正面**：同一 WebDAV 目录中，使用转发上传的无后缀文件仍以客户端原始名称列出；RelayServer 重启后映射继续有效。
- **正面**：用户原生的 `.prop` 文件不会被误改名；查询参数、命名空间前缀、XML 实体及非 href 响应内容得到保留。
- **负面**：PROPFIND 响应不再完全字节透明；映射 sidecar 占用少量 profile 本地空间。上游通过其他客户端在代理之外改名时，旧别名可能保留到同路径被代理显式 PUT/DELETE。
- **验证**：测试覆盖重启后 href 还原、原生 `.prop` 保留、带 query/XML entity、显式 `.prop` PUT 清理旧映射以及现有额外头与转发行为。
