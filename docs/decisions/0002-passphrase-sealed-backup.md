# 0002 — 备份用口令在本机加密（AES-256-GCM + PBKDF2-SHA256，600000 轮）

- 状态：已接受
- 日期：2026-10-16（本仓库首次提交）

## 背景

同步出去的 `Bundle` 里装着模型供应商配置、默认模型、其余 profile 行与插件清单。其中的供应商条目会带 API 端点、模型 id、以及 `apiKeyEnv` 这类指向本机环境变量的字段——虽然不直接是密钥本身，但足以拼出一台机器的模型接入全貌，暴露它用了哪些服务、什么模型、什么 base URL。这些内容要放进一个**用户自己不一定运营的** WebDAV 服务器（坚果云、Nextcloud、Synology、OpenList……）。

现实的威胁模型：

- 服务器方（或其运营者）能读到文件本体。
- 传输中继可能缓存或记录正文。
- 用户可能把同一个文件夹共享给别人，或忘了地址还在某台旧设备上。

被否决的备选：

- **明文传输**：只要服务器落在别人手里，全部配置就是明文可读的。
- **依赖服务端加密**：加密由服务端做、密钥由服务端持有时，服务器运营者依然能读；而且不同 WebDAV 实现根本不提供这套东西，做不到一致性。
- **依赖传输层 TLS**：TLS 只保护「路上」，服务器落盘后仍是明文。
- **让用户自带密钥文件**：多一个必须手动搬运的文件，与「换台电脑填个地址和口令就能用」的目标冲突。

## 决策

备份在**离开本机之前**就用口令封好，服务端自始至终只收到密文。实现全在 `src/crypto.ts`：

- **AES-256-GCM**（`createCipheriv('aes-256-gcm', key, nonce)`），`KEY_BYTES = 32`，`NONCE_BYTES = 12`。
- 密钥由口令经 **PBKDF2-SHA256** 派生（`derive()` → `pbkdf2Async(passphrase, salt, iterations, 32, 'sha256')`），`ITERATIONS = 600_000`，`SALT_BYTES = 16`，salt 与 nonce 每次 `seal` 都重新随机（`randomBytes`）。
- `600_000` 这个数字在代码里注明是「Matches the cost magpie settled on for the same job」——沿用上游已经定过的成本。
- **信封自己的字段被作为 AAD 认证**：`header()` 把 `format/version/kdf/iterations/salt` 拼成字符串喂给 `setAAD`，所以有人把 KDF 参数或 salt 换成弱的会被 GCM 校验发现。
- 打开时**拒绝过于便宜的 KDF**：`iterations` 必须落在 `MIN_ITERATIONS = 100_000` 与 `MAX_ITERATIONS = 10_000_000` 之间，`nonce.length !== NONCE_BYTES` 或 `salt.length < SALT_BYTES` 一律 `CorruptError`（`src/crypto.ts:124-134`）。
- 正文长度 `<= 16`（GCM tag 的长度）视为损坏。

配套的两条输入校验：

**口令不得等于 WebDAV 密码。** 服务器是被发送密码的一方（HTTP Basic，`src/dav.ts:472-474`），所以用密码加密的文件，等于让运行服务器的人可以打开——这正好抵消了加密的目的。保存配置时这条会被拒绝（`src/index.ts:156-162`）：

```
'the passphrase is the WebDAV password: the server is sent the password, and could open the file with it. Pick a passphrase of its own'
```

比较用常量时间的 `sameSecret()`（`timingSafeEqual`，长度不等直接 false），避免比较本身泄露信息。

**空口令被拒。** 全空白口令等于用任何人都能推出来的密钥加密，「比不同步还糟」（`src/crypto.ts:75-77`）：

```ts
if (passphrase.trim() === '') throw new Error('a backup needs a passphrase to seal it with')
```

`usable()` 同样要求 `config.passphrase.trim() !== ''`（`src/state.ts:170-172`），所以自动同步的定时器不会把全空格口令当作「已就绪」而反复跑必然失败的同步。

## 影响

正面：

- 服务器、中继、以及任何拿到这个文件的人，在没有口令的情况下拿不到任何配置内容；`looksSealed()` 之外连正文结构都无从确认（GCM 的 tag 不验证就解不开）。
- AAD 绑定信封元数据，堵掉了「把 `iterations` 改成 1 再暴力破解」这条降级路径。
- 口令与密码分离，用户可以把 WebDAV 账号交给服务商托管，而加密口令只有自己知道。

负面：

- **口令丢失等于备份永久不可读**。没有恢复途径，没有后门——这是设计的必然结果，不是缺陷，但需要用户理解。
- `ITERATIONS = 600_000` 让每次 `seal`/`open` 都要跑约 0.5 秒级的 PBKDF2（测试 `tests/crypto.spec.ts` 22 个用例耗时约 1.7 秒，是五个测试文件里单文件最慢的）。每次同步至少一次 `open` 加一次 `seal`，冲突时留档还会再封几次。
- 口令从 `sync.json` 参与 `stateKey` 的计算，因此**改口令会作废本机基线**（见 [0011](0011-state-key-isolation.md)）：换口令后下一次同步会被当成首次同步对待。
- 信封用两格缩进的 JSON 写出来（`JSON.stringify(envelope, null, 2)`）是为了「文件头一眼能看出是备份」，代价是文件比紧凑格式略大——对一个几十 KB 量级的配置来说无所谓。
