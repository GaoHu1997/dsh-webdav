# 0051 — 转发用例给真实的回环往返留出超时余量

- 状态：`已接受`
- 日期：2026-10-20
- 相关：[0049](0049-relay-collection-and-destination-mapping.md)、[0050](0050-relay-propfind-aliases.md)（本轮新增的转发映射用例）

## 背景

`tests/relay.spec.ts` 与 `tests/relay-host.spec.ts` 不搭 HTTP 假件：每个用例都真起一个上游 HTTP 服务、真让 `RelayServer` 监听回环端口，再逐个请求走过去。本轮的映射用例一个用例里要走七八个往返（上传、列举、重启后再列举、MOVE/COPY），而这台 Windows 机器上单个回环往返约 0.3–0.5 秒，于是最重的用例落在 4.8–7.4 秒，正好压在 vitest 默认的 5000 ms 上：单独重跑同一条用例三次，两次报 `Test timed out in 5000ms`，一次 3.7 秒通过；整套跑时失败更多。

这不是本轮引入的退化：把本轮改动暂存回 HEAD 再跑，既有用例同样慢（单个往返 495 ms，`leaves a redirect that goes somewhere else alone` 3.3 秒），慢的是机器而不是代码。

## 决策

把 `vitest.config.ts` 的 `testTimeout` 提到 20 秒，并在配置里写明依据指向本条。

- 不动用例：慢的原因是真实的往返次数，不是空等；合并断言、少做一次 PROPFIND 都会少测一个真实行为。
- 不在每个用例上单独塞超时：`tests/relay-host.spec.ts` 已经这样加过两处（`ask` 的超时、`vi.waitFor`），继续散落只会让下一条重用例再踩同一块石头。
- 也不把这两份用例排除在本地 `pnpm test` 之外：它们是转发改动唯一的端到端证据，CI 只在 Linux 上跑过。

## 影响

- **正面**：本地 `pnpm test` 给出稳定结论，慢机器不再把「环境慢」报成「功能坏了」；CI 上耗时远低于上限，行为不变。
- **负面**：真挂住的用例要等 20 秒才失败，而不是 5 秒；这个上限同时成为「单个用例允许多慢」的口径。
- **验证**：改配置后整套 `pnpm test` 12 个文件 / 364 条全绿（最重的 `maps extensionless file resources to .prop and keeps allowed extensions` 6.7 秒、`adds the configured headers` 7.4 秒，均在旧上限之外）。
