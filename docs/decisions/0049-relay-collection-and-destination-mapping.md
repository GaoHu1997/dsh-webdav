# 0049 — 集合 PROPFIND 不改名，MOVE/COPY 目标同步转发映射

- 状态：`已接受`
- 日期：2026-10-20
- 相关：[0046](0046-relay-backup-file-extension.md)（文件资源补 `.prop`）、[0050](0050-relay-propfind-aliases.md)（持久化文件别名）

## 背景

转发器为文件资源补 `.prop`，而文件和集合可能共享路径形态。PROPFIND 的 Depth 缺省等价于 infinity；Depth 0 又可查询文件或集合。此前把缺省 Depth 当成 0，会把目录探测请求错误地转发到带 `.prop` 的路径。WebDAV 客户端也可能用 MOVE/COPY 把上传文件原子改名，但只转换请求 URL 会让 Destination 仍指向另一套路径。

## 决策

- PROPFIND 缺省 Depth、非 0 Depth 和尾斜杠路径按集合请求保留名称。
- Depth 0 的路径若无扩展名且没有已知文件别名，按歧义路径保留，不猜测它是文件；有扩展名或已知文件别名时继续走文件资源扩展名规则。这样优先保证目录名称不被改变；新建的无扩展名文件若只进行 Depth 0 探测、且尚未通过其他文件操作建立别名，则不在该探测请求上补 `.prop`。
- 对同一转发器地址内的 MOVE/COPY Destination，将目标路径映射到上游并应用文件资源后缀规则。MOVE 成功后清除源别名并登记目标别名；COPY 保留源别名并登记目标别名。外部 origin 的 Destination 不改写。
- DSH 自身同步使用 `Dav` 客户端与固定同步文件名；本决策只作用于 `RelayServer` 的转发请求。

## 影响

- **正面**：标准目录 PROPFIND 不会因缺省 Depth 被改名；已知文件在 PROPFIND 中仍可映射；MOVE/COPY 的源、目标和 listing href 使用同一映射。
- **负面**：Depth 0 下无扩展名、尚无别名的文件与目录不可区分，因此按目录路径透传；该请求不会自动找到上游补了 `.prop` 的文件。
- **验证**：覆盖缺省/Depth 0/文件型 PROPFIND，以及 MOVE/COPY 的 Destination 上游路径、目标 href 还原与 MOVE 源别名清理。
