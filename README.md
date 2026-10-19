# dsh-webdav-sync

用 WebDAV 在多台电脑之间同步 DSH 的配置。备份在**离开本机之前**就用口令封好（AES-256-GCM + PBKDF2-SHA256，600000 轮），所以服务器上自始至终只有一个密文文件 —— 它看不到你的模型目录、默认模型、插件清单，也看不到 API key 指向的供应商结构。

同步的内容是 DSH profile 里的这几样：

| 份（`Part`） | 取自 | 中文名 |
| --- | --- | --- |
| `models` | `cordis.patch.yml` 的 `llm-pi-ai` 行 | 模型供应商与模型 |
| `defaults` | `cordis.patch.yml` 的 `agent-default-model` 行 | 默认模型 |
| `patch` | `cordis.patch.yml` 里其余的 loader 行（MCP、权限预设、UI 设置、insert 块……） | 其余 profile 配置 |
| `plugins` | `package.json` 的 `dependencies` 与 `dsh.profile.bundles` | 已安装插件 |
| `dirs` | 你在「同步内容」里**新增**的目录（profile 之外的绝对路径） | 附加目录 |

每台电脑各改各的，同步时按份做三方合并，冲突时新的那份胜出、旧的那份留档；服务器上永远只有一份「整个 setup」的版本，而不是 profile 的镜像。

前四份切自 profile 的两个文件。`dirs` 是让你把 profile 之外的目录（笔记、提示词、脚本）也带上：在「同步内容」标题右边点**新增**，填一个绝对路径 —— 那个目录连里面的文件一起封进同一个备份，在另一台电脑上恢复时**写回同一个路径**。它只增不减：同步会写会覆盖，但永远不会删掉里面的文件，详见 [0036](docs/decisions/0036-extra-directories-part.md)。

---

## 参考与来源

设计来自 [magpie](https://github.com/yetone/magpie) 的 `internal/davsync`：同样是「一份密封文件 + 按份三方合并」的思路，本仓库把它移植到 TypeScript 并改成同步 DSH 的配置。

保留了的部分：

- **一份文件而不是镜像**：服务端只存整个 setup 的一个版本（`Bundle`），不是逐文件的目录镜像。
- **按份三方合并**：每个份单独哈希，改一份不会拖着别的份一起走。
- **新者胜 + 败者留档**：两边都改过时保留较新的，另一份写进本机 `sync/` 目录。
- **保守的写入**：读取记录的版本用于 `If-Match`，别的电脑在这中间写过就会被拒绝而不是被静默覆盖。

适配的部分：

- **Go → TypeScript**：进程内没有常驻服务，一次同步就是一次 HTTP 往返加几次文件读写。
- **同步对象改成 DSH profile 行**：magpie 同步的是它自己的配置面；这里同步的是 `cordis.patch.yml` 的 loader 行和 profile 的 `package.json`，所以多了一层 YAML 文档级合并（保留注释、缩进与引号）。
- **`node_modules` 不参与同步**：只同步声明，包在同一台机器上用 pnpm 重新装（见「插件为什么不整目录同步」）。

---

## 安装

这是一个 DSH 插件，由 Host 半边（Node 侧）和浏览器半边（设置卡片）组成。装到 profile 里：

```bash
# 在 profile 目录里（$DSH_PROFILE_DIR，或 $DSH_HOME/profiles/<profile>）
pnpm add dsh-webdav-sync
```

然后在 profile 的 `cordis.patch.yml` 里加上本插件自己的 loader 行：

```yaml
- insert:
    - id: dsh-webdav-sync
      name: 'dsh-webdav-sync'
```

`id` 是配置表单寻址用的 composition entry id（浏览器半边里的 `PLUGIN_ENTRY_ID` 与它一致），`name` 必须等于已安装的包名 —— 浏览器 bundle 按这个名字注册。上面这段就是包内 `cordis.patch.yml` 的全部内容（`package.json` 的 `dsh.bundle.patch` 指向它），所以走 DSH 的 bundle 机制安装时会带上这一行；手动装则需要自己加。

包信息：`dsh-webdav-sync`，版本 `0.1.0`，MIT。

装好后重新加载界面，Settings 里会出现「WebDAV 同步」一页，Plugins 页上对应这张卡片也会出现。

---

## 配置项

配置存在 profile 的 `.dsh-webdav-sync/sync.json`（权限 `0600`），不在 `cordis.patch.yml` 里。下表是 `SyncConfig`（`src/wire.ts`）的全部字段：

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `url` | `string` | `''` | WebDAV 地址。填**文件夹地址本身**，例如坚果云 `https://dav.jianguoyun.com/dav/` 或 Nextcloud `https://…/remote.php/dav/files/<用户名>/`；也可以直接填服务器根（`https://dav.example.com`、`http://192.168.1.10:5005`），带不带尾斜杠都行 |
| `user` | `string` | `''` | WebDAV 用户名 |
| `password` | `string` | `''` | WebDAV 密码。发送给服务器（HTTP Basic） |
| `passphrase` | `string` | `''` | 加密口令。**只在本机用**，加密在文件离开本机之前完成；不得与 `password` 相同 |
| `autoEvery` | `number` | `-1` | 自动同步间隔（分钟）。取值来自 `AUTO_CHOICES = [-1, 3, 15, 30, 60]`；`-1`（`AUTO_MANUAL`）表示只在手动点「立即同步」时同步 |
| `models` | `boolean` | `true` | 是否同步模型供应商与模型这一份 |
| `defaults` | `boolean` | `true` | 是否同步默认模型这一份 |
| `plugins` | `boolean` | `true` | 是否同步已安装插件这一份 |
| `patch` | `boolean` | `true` | 是否同步其余 profile 配置这一份 |
| `dirs` | `string[]` | `[]` | 附加目录的绝对路径，按你添加的顺序。列表本身就是这一份：在这里的目录会被同步，去掉一个就是「这台不再同步它」（文件不会动）。最多 `DIRS_MAX = 5` 个，每个目录最多 2000 个文件 / 8 MiB，路径必须是绝对的 |
| `rememberPassword` | `boolean` | `true` | 是否把地址、用户名和密码留到下次。关掉后保存时 `password` 会被清空，密码只在本次运行内使用 |
| `headers` | `string` | `''` | 额外请求头，一行一条「名字: 值」，空行与 `#` 开头的行忽略。先于每个请求自带的头写入，同名时以请求自带的为准；给了自己的 `authorization` 就不再补 Basic。明文，见下节 |

对应 JSON 长这样：

```json
{
  "url": "https://dav.jianguoyun.com/dav/",
  "user": "me@example.com",
  "password": "…",
  "passphrase": "…",
  "autoEvery": 15,
  "models": true,
  "defaults": true,
  "plugins": true,
  "patch": true,
  "dirs": [],
  "rememberPassword": true,
  "headers": ""
}
```

### 密码和口令存在哪里

`password` 与 `passphrase` 平时只存在两处：

1. `<profileDir>/.dsh-webdav-sync/sync.json`，mode `0600`（目录本身 `0700`）。
2. 运行中的 Host 进程内存里。

关掉「记住密码」之后，第 1 处不再有 `password` —— 它只留在第 2 处，直到 Host 退出。这不是「不用了」，而是「这次运行照样能用、重启 Host 后要重新输」：每条路由都是重新从磁盘读配置建引擎的，密码若在磁盘上被清空，同一个进程里的同步就会拿一个空密码去认证。见 [0019](docs/decisions/0019-session-password-not-remembered.md)。

**它们永远不会被写进 `cordis.patch.yml`。** 原因是 patch 文件本身就是被同步的四份之一 —— 放进去的密码会被下一个同步打包加密、上传到服务器。同理，插件自己的 loader 行在收集 patch 份时被排除（`SELF_ID = 'dsh-webdav-sync'`），所以这一行不会在机器之间来回跑。

**它们也永远不会下发到浏览器。** 卡片拿到的是 `ConfigView`，其中只有 `passwordSet` / `passphraseSet` 两个布尔值。表单里留空提交的含义是「沿用已存的那一个」（`ConfigureBody` 的约定），不是清空 —— 卡片从来没有能力把一个它从未见过的密钥写回去。

**但「沿用」只在同一个账号内成立。** 保存时会把地址与用户名跟上一份配置比一次（`sameAccount`）：地址或用户名变了、而这次提交又没有给出新密码，那个沿用的密码会被丢掉，而不是跟着发到新服务器上。`normaliseUrl` 会吸收末尾斜杠与空白，所以把同一个地址重粘一遍不算换账号。同一次提交里填的新密码不受影响 —— 它是为新地址给的。口令（`passphrase`）不参与这个判断：它只在本机解密，从来不会被发给任何服务器，所以没有「被发到别的服务」这条路径。见 [0015](docs/decisions/0015-password-not-carried-across-accounts.md)。

**「口令不能等于 WebDAV 密码」这条规矩比的是实际会发出去的那个密码**，包括「不记住密码」时留在内存里的那一个。服务器收到密码就能用它打开这份备份，所以这种情况下口令等于等于没设加密 —— 换句话说这条守卫不能因为密码没落盘就被绕过。手上根本没有密码时（例如新机器用新口令加入），这条规矩无话可说，不会拦。见 [0019](docs/decisions/0019-session-password-not-remembered.md)。

要清掉存下来的密码，用「关闭同步」：`turnOff()` 保存的是 `{ ...config, url: '', password: '' }`。值得注意的是它**不清口令**，也**不清状态**（不是 `saveState` 而是 `saveConfig`）—— 重新填回同一地址时 `stateKey` 会变回原值，那条基线仍然算数，所以「关掉又打开」不会被当成加入一个新文件夹，也就不会拿服务器上的旧 setup 覆盖本机较新的那份。

### 额外请求头

有的 WebDAV 服务器除了 Basic 认证还要别的东西：InfiniCLOUD 之类要 `User-Agent`，套在反向代理后面的要 `X-Api-Key`，也有的直接发 Bearer 令牌。`headers` 就是给这种情况的：

- **一行一条 `名字: 值`**，空行与 `#` 开头的行忽略。名字按 HTTP 的 token 规则校验，写坏的行会在**保存时**就被拒（错误里带行号），而不是等到下一次同步才以一个莫名其妙的 400 失败。
- **先写入，再让每个请求盖过它。** 请求自带的头（`if-match`、`if-none-match`、`content-type`、`depth`、`accept-encoding`）随后写入，同名时以请求自带的为准 —— 否则一个手滑的 `content-type` 就能把上传变成另一种类型，而 412 条件写入也会失效。
- **给了 `authorization` 就不再补 Basic。** 没给才用上面那个 `password` 拼 `Authorization: Basic …`，所以 Bearer 能用，而填了密码的配置行为不变。
- **它不算机密。** 与 `password` / `passphrase` 不同，它明文存在 `sync.json` 里，也明文下发到卡片（表单里可直接编辑）。但它也不进 `stateKey`：换请求头只是换了同一把锁的开门方式，那条「上次同步到哪」的基线描述的还是同一个文件。见 [0034](docs/decisions/0034-extra-request-headers.md)。

---

## 界面

同一张卡片出现在两个位置，共用一份状态（`WebdavSyncCard` 的 store）：

| 位置 | 注册点 | 说明 |
| --- | --- | --- |
| Settings 一页 | `settings.section`，`id: 'webdav-sync'`，`order: 22` | 无条件注册 —— 出问题时用户就是从这里进来的，它必须还在 |
| Plugins 页上的卡片 | `plugins.bundle.config`，按包名 `dsh-webdav-sync` 寻址 | 仅在 Host 正在服务本插件命名空间时才出现；没装 Host 半边就不会冒出一张空卡片 |

`order: 22` 是有意的：Settings 导航栏没有滚动条且高度固定，排太后在窗口不高时会被裁掉。

卡片本身按三节排：**服务器**（地址、账号、密码、口令、额外请求头 —— 前四个各占一行，最后一个是多行输入框，每句说明都紧跟在它讲的那个字段的标签下面）、**自动同步**（一排选项卡：关闭同步 / 手动同步 / 3 分钟 / 15 分钟 / 30 分钟 / 1 小时，选中的那个高亮）、**同步内容**（标题右边一个**新增**按钮，下面是四份各一行：前面复选框决定同步不同步，下面一行小字说这份同步的是什么，右端是「已一致 / 仅本机有改动 / 仅服务器有改动 / 两边都有改动」；指定了目录的话，再下面是一组**附加目录**行，每行一个绝对路径输入框和「移除」，读不出来的目录就在列表下方按「哪条路径、为什么」说出来）。同步动作（测试连接/预览/立即同步/服务器覆盖本机/撤销恢复/本机覆盖服务器）在「同步内容」末尾排成一行，「放弃改动/保存」在整张卡片最外层。按钮只有两种样子：每组动作里只有一个实心的主操作（保存、立即同步、确认框的「确定」），其余一律描边。

附加目录那一份**没有复选框**：列表本身就是开关。空列表就是「这台不同步任何附加目录」，去掉一行就是「这台不再同步这个目录」—— 再加一个总开关，迟早会出现「开关是关的、列表却还在同步」这种自相矛盾的状态（[0036](docs/decisions/0036-extra-directories-part.md)）。「新增」在满 5 个之后变灰。

浏览器半边不读 profile 文件、也不说 WebDAV，它只 `fetch` Host 半边的路由（全部在 `ROUTE_PREFIX = '/plugin/webdav-sync'` 之下）：

`/status`、`/config`、`/check`、`/sync`、`/preview`、`/restore`、`/undo`、`/upload`、`/dismiss`、`/off`、`/install`。

---

## 卡片上的动作

| 按钮 | 路由 | 做什么 | 写哪里 |
| --- | --- | --- | --- |
| **保存** | `/config` | 存下地址、账号与口令、额外请求头、自动同步间隔、同步哪几份，以及附加目录的列表 | `sync.json`（口令与密码按「记住密码」决定写到哪） |
| **放弃改动** | 无（只在浏览器半边） | 把表单恢复成上次从 Host 取到的状态 | 不写任何东西 |
| **立即同步** | `/sync`（`force: true`） | 跑一次三方分片合并 | 总会写服务器（`force` 覆盖「没什么可说就不写」）；本机只在合并结论需要改它时才写，且被替换的副本先封存进 `sync/` |
| **预览** | `/preview` | 用和真正合并同一套判断，说出每一份会取哪边 | 不写 profile、不写服务器（但会读一次服务器；若那份服务器文件是截断的、且本机有基线，会先留档一份 `-server-damaged`） |
| **测试连接** | `/check` | 到达服务器、报告账号能否读写、服务器上有没有我们的备份、多大、什么时候写的 | 服务器上缺 `dsh-webdav` 文件夹时会创建它（首次同步本来也要建） |
| **服务器覆盖本机** | `/restore` | 不比较谁改了什么，服务器上有的每一份都拿过来（附加目录写回它被指定时的那个绝对路径） | 本机文件；替换前的本机 setup 先封存，供撤销 |
| **本机覆盖服务器** | `/upload` | 覆盖一个**不是我们备份**的服务器文件 | 服务器文件；原文件先留档到 `sync/` |
| **撤销恢复** | `/undo` | 把上次 Restore 换掉的本机 setup 放回去 | 本机文件 |
| **安装缺少的插件** | `/install` | 在 profile 目录跑 `pnpm install` | `node_modules`（同步声明后由本机拉包） |
| **关闭同步**（自动同步选项卡的第一个） | `/off` | 清空本机配置（清 `url` 与 `password`），服务器上的文件保持原样 | `sync.json`（`sync-state.json` 刻意保留） |
| **知道了** | `/dismiss` | 收掉上次同步的「替换了内容」通知 | `sync-state.json` |

「服务器覆盖本机」「本机覆盖服务器」「关闭同步」三个动作都要先在卡片上确认一次（「关闭同步」从「自动同步」选项卡里选，选完弹确认框）；「撤销恢复」只在真的存在一次可撤销的 Restore 时才可用。

「立即同步」在卡片上是带 `force` 调用的（`requestSync({ force: true })`）：即使合并结论与服务器现状完全一致，也会照样写一次服务器。代码里给的理由很直白 —— 一个看起来什么也没做的按钮没人会信。普通同步（包括自动同步的定时器）则相反：结论相同就一个字节都不碰服务器上的文件。

「安装缺少的插件」只在 profile 声明的包名不在 `node_modules` 里时才有意义；`@deepseek-ai/dsh-` 开头的内置包会被跳过，它们随 DSH 一起安装，不属于 profile。当确实缺包时，Host 会把这些包名一并下发（`pendingNames`），卡片上那句「有插件尚未安装」后面列的就是它们，而不是只给一个需要你自己去猜的提示。

---

## 合并是怎么做的

一次同步是**每份一次的三方合并**，三方是：本机现在、服务器现在、以及上次同步留下的基线。

1. **每份各自哈希**。`hashesOf` 对每一份做 canonical JSON（对象 key 排序）的 SHA-256。因此 YAML 里 key 的书写顺序变化不会造成假变更。
2. **判断每边是否动过**：
   - `changedHere = !first && local[part] !== state.local?.[part]`
   - `changedThere = first || remote.hashes[part] !== state.remote?.[part]`
   - 比的是哈希不是「在不在」—— 只比存在与否会把另一台电脑做的编辑读成「没变」，然后悄悄留下本机更旧的那份。
3. **只本机改** → 推上去。**只服务器改** → 取回来。**两边都没改** → 本机有的就以本机为准，避免只在一侧存在的份被误删。
4. **两边都改** → 比时间：服务器那侧用 `Bundle.created`，本机这侧用文件的 mtime（`patch` 份用 `cordis.patch.yml` 的 `mtimeMs`，`plugins` 份用 `package.json` 的 `mtimeMs`，`dirs` 份用它读到的文件里最新的那个 `mtimeMs`）。本机不早于服务器则本机胜，否则服务器胜。**冲突一旦发生，两边都留档到 `sync/`**（`-this-computer` 与 `-server`）。
5. **删除会传播**：服务器上少了某份，本机也把它去掉（`applied[part] = null`）。**三个例外**：`plugins` 份永不删除（它是加载 shell 的东西），`dirs` 份永不删除（见下节），以及首次同步（本机没有基线）不删任何东西。关掉的份（`syncsPart` 为 false）也不删本机的东西，只是不再参与。
6. **每次覆盖前先留档**：本机文件将被改写前，当前的整个 setup 会被封成 `sync/<时间戳>-before-apply.prop`。**第一次同步（以及状态文件丢了之后的第一次）也留这一份**：那种情况下服务器整套配置会被套到本机上，哈希上与「刚加入这台服务器」没法区分，所以插件不猜哪边该赢，而是照常让服务器赢、同时把本机那份封存下来并在通知里**点名它的路径**（`sync/this-computer`），Restore 和 Undo 都能把它放回去。两边本来就一样时不会多出这份副本。见 [0024](docs/decisions/0024-adopting-server-keeps-local.md)。
7. **本机文件只在服务器写成功之后才写**。上传失败的话，这台电脑不会既拿着别人的 setup、又说不清自己那份去哪儿了。
8. **关掉的份会被原样带过上传**：把一份关掉，只是不再动本机的它、也不再从服务器取它，但服务器上那份的存在会被保留 —— 不能因为一台机器关了它，就替还开着它的机器把它删掉。恢复和撤销也一样：一份被关掉，恢复就不会把它写进来，撤销也不会去动它。

### 卡片上的「已改动」是怎么算的

卡片的状态**不去问服务器**（每开一次就发一次请求、解封一次 600,000 轮 PBKDF2，不划算），它只拿上次同步留下的两份基线比：`localChanged` 是「这份文件从上次同步到现在动过没有」，`remoteChanged` 是「两边记录对不上，需要下一次合并去调和」。两者互斥，所以只在本机改一次显示的是「仅本机有改动」，不会是「两边都有改动」。

要说清楚的是：**卡片上的状态不代表服务器现在的真相**。要真知道服务器那边是什么，按「预览」—— 它用同一套合并判断去真读一次服务器，逐份说出会取哪边（见 [0029](docs/decisions/0029-status-says-only-what-it-knows.md)）。

写到本机的 YAML 走 `yaml` 的 Document API 而不是「解析成对象再序列化」，所以一个人的注释、缩进、引号风格会在只改了一个 provider 的同步里活下来。合并结论与原文件相同时，`applyPatch` 直接把读到的原始字节还回去 —— YAML 重新序列化不是字节稳定的（`[text, image]` 会被写成 `[ text, image ]`），改写一个什么都没变的文件等于撒谎。

本机写入用「写同目录临时文件再 rename」的方式（`writeAtomic`），断电或崩溃只会留下旧文件或新文件，不会是半个。

### 插件为什么不整目录同步

`node_modules` 不进同步 —— 它是构建产物，动辄几十兆。同步的是**声明**（`dependencies` + `dsh.profile.bundles`），包由本机在 profile 目录里用 `pnpm install` 重新拉取，也就是 DSH 自己的插件管理器用的那条命令。所以清单从别处同步过来之后，需要点一次「安装缺少的插件」。

顺带一提，`applyManifest` 是**镜像**而不是合并这份声明：别的电脑删掉的插件在这里也会从声明里去掉，否则两边永远收敛不了。但这只是文件里少一行，并不会卸载任何包。

### 附加目录：只增不减

`dirs` 这一份和上面四份有三处不同，都是因为**里面是用户自己的文件**：

- **写入只增不减。** 同步会写、会覆盖，但永远不为这条路删掉任何东西。在一台电脑上删掉的笔记会从别处回来；要在所有电脑上删掉，手动删。服务器上这一份整个消失时也一样：本机仍然指定着目录，就把自己的副本推回去，而不是照着删。
- **读不出来不等于空目录。** 目录被删了、盘没挂上、没权限，读取会把这条路径记进 `dirProblems`，并在这一份里**用服务器上的副本原样顶替**这次读取 —— 否则「读不出来」会被读成「这个目录里什么也没有」，下一次推上去就等于替所有人删了整个目录。卡片上会直说哪条路径没读成、为什么。`missing` 再区分「只是不在这台电脑上」（恢复可以建它）与「读不了」（绝不盲写）。
- **有上限，超了整目录不同步。** 最多 5 个目录、每个目录 2000 个文件 / 8 MiB（base64 之前）。`node_modules`、`.git` 与符号链接静默跳过。带半个目录上去比不带更危险，所以超限是拒绝整个目录，而不是截断着带。

路径是这一份的数据：`writeDirs` 按备份里的 `path` 写回**同一个目录**，而不是在另一台电脑上另造一个。相对路径、盘符不存在的路径不读也不写，但条目留在这一份里（丢掉它等于替那台电脑删了它）。写回时只动绝对路径；条目里用 `..` 或开头带 `/` 去指到目录以外的文件（`under` 检查）直接不写。见 [0036](docs/decisions/0036-extra-directories-part.md)。

---

## 服务器上的文件

```
<你填的 WebDAV 地址>
└── dsh-webdav/
    └── dsh-profile.prop
```

常量在 `src/wire.ts`：`REMOTE_FOLDER = 'dsh-webdav'`、`REMOTE_FILE = 'dsh-profile.prop'`、`BACKUP_EXT = '.prop'`。这个文件夹由插件自己 MKCOL 创建。

改后缀之前这个文件叫 `dsh-profile.dshsync`。老文件夹里的那个名字仍会被读（`LEGACY_REMOTE_FILE`），所以升级后的第一次同步看到的是自己上次留下的备份，而不是「服务器上什么都没有」——后者会让这台电脑把自己的配置推上去，盖掉另一台电脑留下的那份。新名字找不到时才会去看旧名字，此后只写新名字：旧文件不再更新，也不会被自动删除，可以手动删。见 [0035](docs/decisions/0035-backup-suffix-prop.md)。

`dsh-profile.prop` 是一段 JSON 信封，长这样：

```json
{
  "format": "dsh-webdav-sync-backup",
  "version": 1,
  "kdf": "pbkdf2-sha256",
  "iterations": 600000,
  "salt": "…",
  "nonce": "…",
  "data": "…base64(密文 ‖ GCM tag)…"
}
```

信封自己的字段（`format/version/kdf/iterations/salt`）被作为 GCM 的 AAD 一起认证，所以 KDF 参数或 salt 被换成弱的会被发现。缩进写成两格是有意的：文件头一眼能看出是备份，而中继把正文截断时也还会留下一个可辨认的头。

读取时会拒绝过于便宜的 KDF（`iterations` 必须在 `100000` 与 `10000000` 之间）、长度不对的 nonce、短于 16 字节的 salt。

---

## 安全规则

这几条是刻意的，且每一条都对应代码里的一个判断：

- **不是我们备份的文件，绝不静默覆盖。** 服务器上那个文件如果打不开成我们的格式（`NotBackupError`），同步会报错并指向「本机覆盖服务器」这个显式动作，而不是顺手把它换掉。那可能是别人的东西。
- **别的口令封的文件，也绝不覆盖。** 如果文件是我们的格式但口令打不开（`PassphraseError`），同步会说你该用另一台电脑上设的口令；连「本机覆盖服务器」也会拒绝 —— 那是一份别人的备份，这台电脑没有资格替它。
- **损坏/截断的备份只在「本机曾同步过」时才在其上重建。** 判断条件是 `state.local !== undefined`：本机有基线，说明这个文件夹确实是我们的，被截断的字节会先留档成 `sync/<时间戳>-server-damaged.prop`，再写一份完整的覆盖上去。只有开头看起来像我们文件的中断正文才算损坏（`looksSealed` 检查前 256 字节），门户登录页之类的东西不会被当成我们的残片。
- **能解开、但内容不像自己写的文件，按损坏处理，不按「别人的」处理。** 分片形状不对（比如 `patch.entries` 不是数组）的包会让合并在半路炸出 `TypeError`，或者把一份空配置当成本机设置写下去。所以解封之后先校验每一份的形状，不对就报错，并且**说清是哪一份**：`服务器上的文件是一份读不了的 dsh 同步备份：其中「plugins」这一份的形状不是本插件写出来的`。本机有基线时走重建路径（本机编辑不会被清空），没有基线时明确拒绝，同时告诉用户可以用「本机覆盖服务器」。见 [0022](docs/decisions/0022-validate-part-shapes.md)。
- **附加目录只写不删，且只写回它被指定时的那个路径。** 同步会往这些目录里写文件、覆盖文件，但永远不会删掉里面的任何东西：镜像删除是唯一一种事后说不清也补不回来的操作，而「删了又回来」只是烦人。写回时只动本机上的绝对路径，条目里想用 `..` 或绝对路径走出目录的文件直接不写；一个目录读不出来时（盘没挂上、没权限）这一份取服务器上的副本，绝不当成空目录推上去。见 [0036](docs/decisions/0036-extra-directories-part.md)。
- **状态文件读不出来时不当成没有状态。** 只有文件**真的不在**才算第一次同步；它在却解不开，会说出是哪个文件、解析错在哪，而不是悄悄退回「这是一台新电脑」然后让服务器上的 setup 覆盖本机。（本机自己的 `cordis.patch.yml` / `package.json` 坏了也一样报文件名。）见 [0027](docs/decisions/0027-damaged-is-not-missing.md)。
- **口令不得等于 WebDAV 密码。** 服务器会被发送密码（Basic 认证），所以用它加密的文件，等于让服务器的运营者能解开。保存时这条会被拒绝：`口令不能和 WebDAV 密码相同：密码是要发给服务器的，服务器可以拿它打开文件。请另设一个口令`。比较用的是常量时间实现（`sameSecret`）。
- **密码不会被带到另一个账号上。** 空密码框的含义是「沿用已存的那个」，而这只在同一个服务器 + 同一个用户名下成立；地址或用户名一变，沿用的密码就被丢掉（`sameAccount`），免得 A 服务的凭据被发到 B 服务。这台机器上的自动同步定时器因此也没有这条路径 —— 它不需要任何人为动作就会发请求。见 [0015](docs/decisions/0015-password-not-carried-across-accounts.md)。
- **空口令被拒。** 全空白的口令等于用任何人都能推出来的密钥加密，比不同步还糟：`seal()` 会抛 `备份需要一个口令来加密`，`usable()` 同样要求 `passphrase.trim() !== ''`，所以自动同步的定时器也不会把全空格的口令当作「已就绪」而反复跑必然失败的同步。
- **写入带版本条件。** 读到的 ETag 会用于 `If-Match`；别的电脑在这中间写过，写入会被拒绝（`ChangedError`）而不是被静默覆盖。中继把长上传截断的情况会被读回长度校验发现，最多重试 3 次。
- **没有 ETag 的服务器（写不了条件请求）上，刚写完的那份编辑不会被下一次同步收回去。** 这种服务器上写入是「盲写」，之后必须再读一遍全文来确认，而这次读很容易被当成「别人刚改过」。插件因此记住刚写下的字节：只有下一次读回来的内容确实和它不一样时，才把基线退回写之前的那份。见 [0017](docs/decisions/0017-blind-write-baseline-guard.md)。
- **状态按「服务器 + 账号 + 口令」隔离。** `stateKey` 是 `sha256(url ‖ '\0' ‖ user ‖ '\0' ‖ passphrase)`。换了服务器、账号或口令，旧的基线哈希描述的是另一个文件，会被整体作废，不会拿错误的对端做合并基线。**密码故意不在这个键里**：同一台服务器上的密码轮换只是换了同一把锁的钥匙，那条基线描述的仍然是同一个文件，作废它反而会让下一次同步变成「首次加入」，把服务器上的 setup 当成本机的样子套下来。见 [0026](docs/decisions/0026-password-not-in-state-key.md)。
- **一次同步只跑一个。** sync / 恢复 / 上传 / 撤销都经过同一条队列，所以两次同步不会同时去改同一个临时文件 —— 那正是 Windows 上 rename 偶发失败的来源。一次失败不会卡死后面那一次。见 [0018](docs/decisions/0018-serialize-writes.md)。

---

## 本机文件

全部在 profile 的 `.dsh-webdav-sync/` 之下：

| 路径 | 权限 | 内容 |
| --- | --- | --- |
| `<profileDir>/.dsh-webdav-sync/sync.json` | `0600` | 同步配置，**含 WebDAV 密码与加密口令** |
| `<profileDir>/.dsh-webdav-sync/sync-state.json` | `0600` | 同步状态：服务器版本、各份哈希、上次通知、可撤销的 Restore、上次失败原因 |
| `<profileDir>/.dsh-webdav-sync/sync-server.prop` | `0600` | 上次读/写的服务器正文缓存（让「只本机变过」的同步不必下载它正要覆盖的文件） |
| `<profileDir>/.dsh-webdav-sync/sync/` | `0700` | 被替换掉的副本。每个 tag 保留最新 5 份 |

profile 目录的解析顺序（与 `dsh-git-branch` 一致）：`profileDir` 配置项（必须是绝对路径）→ `$DSH_PROFILE_DIR` → `<home>/profiles/<name>`，其中 `<home>` 取 `$DSH_HOME`（须是绝对路径）否则 `~/.dsh`，`<name>` 取 `$DSH_PROFILE` 否则 `desktop`。空字符串一律当作没设。

同步的文件一共就两个：profile 的 `cordis.patch.yml` 与 `package.json`。

---

## 开发

```bash
pnpm install
pnpm test          # vitest run —— 207 个测试
pnpm run typecheck # tsc -p tsconfig.client.json --noEmit
pnpm run build:all # pnpm run build && pnpm run build:client
```

`package.json` 里的脚本照抄如下：`build` = `tsc -p tsconfig.json`，`build:client` = `tsdown`，`build:all` = `pnpm run build && pnpm run build:client`，`watch:client` = `tsdown --watch`，`test` = `vitest run`，`typecheck` = `tsc -p tsconfig.client.json --noEmit`，`prepublishOnly` = `pnpm run typecheck && pnpm test && pnpm run build:all`。

`lib/` 是**构建产物**（`build` 出 Node 半边，`build:client` 出浏览器 bundle），已 gitignore，不进仓库；它通过 `prepublishOnly` 进入 npm tarball。要跑 `pnpm run build:all` 之后 `lib/` 才有东西。发布时 sourcemap 不进 tarball（`files` 里有 `"!lib/**/*.map"`），所以浏览器 bundle 用 `sourcemap: 'hidden'` 打：本地构建仍有 map 可用，产物里则不会留下一个指向已排除文件的 `sourceMappingURL` 注释（见 [0014](docs/decisions/0014-hidden-sourcemap.md)）。

环境要求：`engines.node >= 22.19`，包管理器 `pnpm@11.8.0`（`packageManager` 字段）。运行时依赖只有 `yaml`；Host 半边依赖 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/schemastery` 作为 peerDependencies。

测试分布：`tests/engine.spec.ts`（54）、`tests/dav.spec.ts`（37）、`tests/store.spec.ts`（30）、`tests/state.spec.ts`（23）、`tests/client-card.spec.ts`（22）、`tests/crypto.spec.ts`（22）、`tests/index.spec.ts`（13）、`tests/install.spec.ts`（6），共 207 例。

---

## 决策记录

本仓库非平凡变更的取舍记录在 [`docs/decisions/`](docs/decisions/README.md)，每条含背景、决策（含被否决的备选）与影响两面。其中 [0029](docs/decisions/0029-status-says-only-what-it-knows.md) 说明卡片上「已改动」的算法与它**不代表**服务器真相的理由，[0030](docs/decisions/0030-review-findings-not-changed.md) 记录一次对抗性源码审查里**刻意不改**的那几条（以及每一条为什么）—— 那一篇的末尾有一张复现到决策的对照表。

---

## 许可

MIT © GaoHu1997（奋斗的小高）

---

## English

`dsh-webdav-sync` keeps a DSH profile the same across computers through a WebDAV folder. It syncs four parts — the model catalog (the `llm-pi-ai` row of `cordis.patch.yml`), the default model (`agent-default-model`), the remaining profile-patch rows, and the installed-plugin list from `package.json`.

The whole backup is sealed on this computer with a passphrase (AES-256-GCM under a PBKDF2-SHA256 key, 600000 iterations) before it is uploaded, so the server only ever holds ciphertext at `<address>/dsh-webdav/dsh-profile.prop`. Each part is hashed on its own and merged three-way against the last synced baseline: one side changed wins, both changed keeps the newer and files the loser under `<profileDir>/.dsh-webdav-sync/sync/`, and every copy that gets replaced is sealed aside first. Removals propagate — except the plugin list, which is never removed.

The design is ported from [magpie](https://github.com/yetone/magpie)'s `internal/davsync` (Go → TypeScript, syncing DSH profile rows instead of magpie's own configuration). The WebDAV password and the passphrase live in `<profileDir>/.dsh-webdav-sync/sync.json` at mode 0600 and are never written into `cordis.patch.yml` — the patch is itself one of the things that travels — and never sent to the browser, which only receives `passwordSet` / `passphraseSet` booleans.

A file on the server that is not a backup of ours is never silently overwritten; restoring from it or writing over it are explicit actions. License: MIT.
