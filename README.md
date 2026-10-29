# dsh-webdav-sync

用 WebDAV 在多台电脑之间同步 DSH 的配置。备份在**离开本机之前**就用口令封好（AES-256-GCM + PBKDF2-SHA256，600000 轮），所以服务器上自始至终只有一个密文文件 —— 它看不到你的模型目录、插件清单、API 密钥，也看不到密钥属于哪个供应商。

同步的内容是 DSH profile 里的这几样：

| 份（`Part`） | 取自 | 中文名 |
| --- | --- | --- |
| `models` | 最后生效的 `llm-pi-ai` 行：`cordis.patch.yml`，或遮住它的 `$DSH_HOME/cordis.patch.yml` | 模型供应商与模型 |
| `patch` | `cordis.patch.yml` 里其余的 loader 行（权限预设、UI 设置、insert 块……） | 其余 profile 配置 |
| `mcp` | `cordis.patch.yml` 里 MCP 服务器的行（`@deepseek-ai/dsh-mcp-client` 的那些） | MCP 服务器 |
| `skills` | `$DSH_HOME/skills` 下每个含 `SKILL.md` 的技能文件夹，连里面的文件 | 技能 |
| `plugins` | `package.json` 的 `dependencies` 与 `dsh.profile.bundles` | 已安装插件 |
| `dirs` | 你在「同步内容」里**选择**的目录（profile 之外的绝对路径，或以 `~` 开头按各台电脑的 DSH 主目录解析） | 附加目录 |
| `keys` | DSH 凭据服务里、被上面几份点名的那些 API 密钥（附加目录 JSON 文件里 `ref` 字段点名的也算） | API 密钥 |

模型配置按 Loader 的覆盖顺序取**最后一个带 `config` 的适用 `llm-pi-ai` 行**；后面的 `disabled` 等元数据行不遮蔽前面的配置。同步保留该配置中 `providers` 的键序和显式 `models` 数组的顺序。宿主界面另有账号/官方供应商优先、内置目录顺序等展示规则；纯 provider 重排也可能要重启 DSH 才反映到运行中的列表。未显式配置模型列表时，列表来自各自宿主的内置目录，目录版本不同仍可能显示不同顺序（[0065](docs/decisions/0065-effective-model-overrides.md)）。

DSH 还会把 `$DSH_HOME/cordis.patch.yml`（家目录覆盖层）排在 profile 的 patch **之后**，并对 `config` 整体替换：那层若有带 `config` 的 `llm-pi-ai` 行，它才是真正生效的清单，profile 里同步来的那份会被整行遮住 —— 这正是「同步过去、重启也还是旧顺序」的原因。所以模型份按**最后生效的层**读写：家层是唯一的清单时（profile 里没有）写进家层；两层都有时，把那行从家层删掉（删之前先封进 `sync/`），让 profile 里同步过来的那行重新生效，一份清单只留一个主人（[0071](docs/decisions/0071-sync-the-catalog-where-it-takes-effect.md)）。

每台电脑各改各的，同步时按份做三方合并，冲突时新的那份胜出、旧的那份留档；服务器上永远只有一份「整个 setup」的版本，而不是 profile 的镜像。

前四份切自 profile 的两个文件（`mcp` 的行本来就写在 `cordis.patch.yml` 里，只是从今往后被单独看待，见下文），`skills`、`dirs` 与 `keys` 各是一份自己的东西。`dirs` 是让你把 profile 之外的目录（笔记、提示词、脚本）也带上：在「同步内容」里点附加目录那一行名称右边的**选择目录**（一个不带框的文字按钮），挑一个目录 —— 它连里面的文件一起封进同一个备份，在另一台电脑上恢复时**写回同一个路径**。它只增不减：同步会写会覆盖，但永远不会删掉里面的文件；这一行和其余几份一样有自己的开关（关掉只是「这台不带」，谁也删不掉），详见 [0036](docs/decisions/0036-extra-directories-part.md)。它的开关默认是**关**：目录整份带走，没点名要带之前不动它。

`skills` 一份是 DSH 的技能文件夹：`$DSH_HOME/skills` 下每个含 `SKILL.md`（停用的叫 `SKILL.md.disabled`）的子目录连里面的文件一起走，恢复时写回同一个根下的同名文件夹。它和 `dirs` 同一个契约：只增不删，同步永远不会删掉一个技能，两边都留着就两边都留着。但开关默认是**开**的（技能就是配置本身，不像附加目录那样是本机的私货）；技能目录下 `state.json` 与 `repos/` 这两个面板自己的文件**不随行**（技能源记着本机的绝对路径，换台机器就是错的）。一个技能读不出来时，那一个照旧拿服务器的拷贝顶上，并在卡片上按「哪个技能、为什么」说出来；连技能根都列不出来时整份让路，服务器那份原样带过。详见 [0075](docs/decisions/0075-mcp-and-skills-parts.md)。

`mcp` 一份是 `cordis.patch.yml` 里的 MCP 服务器行（`name: '@deepseek-ai/dsh-mcp-client'` 的那些）。它和其余 profile 配置**共用同一个文件**，只是在同步里被拆出来单独一个开关、单独报「两边都改过」：合并逐行做，跟其余配置行一模一样。备份文件的形状一个字节都没变（MCP 行照旧躺在 `patch` 份的行里），所以还没升级的电脑读到的还是它认识的那个文件，一行都不会被误删。详见 [0075](docs/decisions/0075-mcp-and-skills-parts.md)。

默认模型那一份（`cordis.patch.yml` 的 `agent-default-model` 行）**不在同步内容里**：换一次模型就换一次这一行，带着它只会让每次换模型都成为一次「本机有改动」的同步，而这一行本身没有多少值得跨机同步的东西。它留在各自的电脑上 —— 收集 patch 份时和本插件自己的 loader 行一样被排除（[0056](docs/decisions/0056-drop-default-model-part.md)）。

`keys` 补的是 profile 与「能用的配置」之间的那道缝：DSH 的 profile 里从来不存密钥，只存密钥的**名字**（`apiKeyEnv` / `secretEnv`），真值在本机的凭据服务里（`$DSH_HOME/.credentials.yaml`）。只同步 profile 的话，另一台电脑会拿到一份完整的供应商列表，然后每个 provider 都报 `MISSING_CREDENTIAL`。这一份把名字对应的值一起带走，同样用口令封在文件里；名字从即将发出的那几份配置里读出来，所以密钥跟着点它名的那一份走。只发**托管存储**里的值（环境导出的不发），**只写不删**，两边都改过时本机赢（凭据没有 mtime，比不出谁新）。详见 [0054](docs/decisions/0054-sync-api-keys.md)。

---

## 参考与来源

设计来自 [magpie](https://github.com/yetone/magpie) 的 `internal/davsync`：同样是「一份密封文件 + 按份三方合并」的思路，本仓库把它移植到 TypeScript 并改成同步 DSH 的配置。

保留了的部分：

- **一份文件而不是镜像**：服务端只存整个 setup 的一个版本（`Bundle`），不是逐文件的目录镜像。
- **按份三方合并**：每个份单独哈希，改一份不会拖着别的份一起走。
- **新者胜 + 败者留档**：两边都改过时保留较新的，另一份写进本机 `sync/` 目录。
- **保守的写入**：读取记录的版本用于 `If-Match`，别的电脑在这中间写过就会被拒绝而不是被静默覆盖。

适配的部分：

- **Go → TypeScript**：一次同步按需进行 HTTP 往返与文件读写；可选的本机转发开启后另有一个随 Host 运行的回环监听器。
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
| `plugins` | `boolean` | `true` | 是否同步已安装插件这一份 |
| `patch` | `boolean` | `true` | 是否同步其余 profile 配置这一份 |
| `keys` | `boolean` | `true` | 是否同步 API 密钥这一份。关掉之后这台电脑不读也不写任何密钥，服务器上那份原样带过 —— 只是「这台不带」，不是「删掉它」。旧配置里没有这个键，读作开 |
| `mcp` | `boolean` | `true` | 是否把 MCP 服务器的行单独同步（它们写在 `cordis.patch.yml` 里，和其余配置行共用一个文件，只是单独一个开关、单独报「两边都改过」）。关掉就是「这台的服务器列表不外传」，服务器上那份原样带过。旧配置里没有这个键，读作开 |
| `skills` | `boolean` | `true` | 是否同步技能文件夹这一份（`$DSH_HOME/skills`）。关掉之后这台电脑不读也不写任何技能，服务器上那份原样带过。同步只增不删，永远删不掉一个技能。旧配置里没有这个键，读作开 |
| `dirs` | `string[]` | `[]` | 附加目录的路径，按你添加的顺序。绝对路径按字面跨机器匹配；`~` 开头的路径按字面旅行、每台电脑各自解析到自己的 DSH 主目录（`$DSH_HOME`，缺省 `~/.dsh`），适合同步插件自己的数据目录（如 `~/dsh-model-think-level`）。列表说「同步哪几个」，开关说「这台带不带」。去掉一个就是「这台不再同步它」（文件不会动）。最多 `DIRS_MAX = 5` 个，每个目录最多 2000 个文件 / 8 MiB；绝对路径必须是本机路径，`~` 之外开头的相对路径会被拒绝 |
| `dirsEnabled` | `boolean` | `false` | 附加目录这一份的开关，默认关。关掉之后这台电脑不读也不写任何附加目录，列表原样留着，服务器上那份也不动。旧配置里没有这个键，读作关 —— 目录整份带走，默认不动它 |
| `rememberPassword` | `boolean` | `true` | 是否把上游 WebDAV 密码留到下次。关掉后保存到磁盘的 `password` 为空，本次运行仍用内存里的密码；重启 Host 后需重新输入。不影响下面生成的本地转发账号 |
| `headers` | `string` | `''` | 额外请求头，一行一条「名字: 值」，空行与 `#` 开头的行忽略。先于每个请求自带的头写入，同名时以请求自带的为准；给了自己的 `authorization` 就不再补 Basic。同步与本机转发共用。明文，见下节 |
| `relayEnabled` | `boolean` | `false` | 本机转发开关。复用本表的 `url`、`user`、`password`、`headers`，与主表单一起保存；关掉只停止监听，保留端口与本地账号 |
| `relayPort` | `number` | `3426` | 只在 `127.0.0.1` 监听的端口，持久化而非每次启动随机分配；用「换一个端口」显式修改后按同一个「保存」生效 |
| `relayUser` | `string` | `''` | 首次开启转发并保存时生成的本地 Basic 用户名，之后沿用；保存在本机，不上传 |
| `relayPassword` | `string` | `''` | 与 `relayUser` 一起生成并保存的本地 Basic 密码，卡片显示且可复制；不是上游 WebDAV 密码，不受 `rememberPassword` 开关影响 |

对应 JSON 长这样：

```json
{
  "url": "https://dav.jianguoyun.com/dav/",
  "user": "me@example.com",
  "password": "…",
  "passphrase": "…",
  "autoEvery": 15,
  "models": true,
  "plugins": true,
  "patch": true,
  "keys": true,
  "mcp": true,
  "skills": true,
  "dirs": [],
  "dirsEnabled": false,
  "rememberPassword": true,
  "headers": "",
  "relayEnabled": false,
  "relayPort": 3426,
  "relayUser": "",
  "relayPassword": ""
}
```

### 密码和口令存在哪里

`password` 与 `passphrase` 平时只存在两处：

1. `<profileDir>/.dsh-webdav-sync/sync.json`，mode `0600`（目录本身 `0700`）。
2. 运行中的 Host 进程内存里。

关掉「记住密码」之后，第 1 处不再有 `password` —— 它只留在第 2 处，直到 Host 退出。这不是「不用了」，而是「这次运行照样能用、重启 Host 后要重新输」：每条路由都是重新从磁盘读配置建引擎的，密码若在磁盘上被清空，同一个进程里的同步就会拿一个空密码去认证。见 [0019](docs/decisions/0019-session-password-not-remembered.md)。

**它们永远不会被写进 `cordis.patch.yml`。** 原因是 patch 文件本身就是被同步的几份之一 —— 放进去的密码会被下一个同步打包加密、上传到服务器。同理，插件自己的 loader 行在收集 patch 份时被排除（`SELF_ID = 'dsh-webdav-sync'`），所以这一行不会在机器之间来回跑。

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

卡片的三个主要设置区依次是：**服务器**（地址、账号、密码、口令、额外请求头 —— 前四个各占一行，最后一个是多行输入框，每句说明都紧跟在它讲的那个字段的标签下面）、**自动同步**（一排选项卡：关闭同步 / 手动同步 / 3 分钟 / 15 分钟 / 30 分钟 / 1 小时，选中的那个高亮）、**同步内容**（标题右边是一个只重读状态的**刷新图标**（鼠标悬停和读屏都叫「刷新状态」），下面几份各一行，顺序固定为**模型供应商与模型 → API 密钥 → 已安装插件 → MCP 服务器 → 技能 → 其它 profile 配置**（密钥紧跟它点名的那份供应商，[0067](docs/decisions/0067-part-order-and-backup-icons.md)）：前面复选框决定同步不同步，下面一行小字说这份同步的是什么，右端是「已一致 / 仅本机有改动 / 仅服务器有改动 / 两边都有改动」；最后一行是**附加目录**，复选框一样在行首、默认不勾，名称右边多一个**选择目录**文字按钮（不带框），选中的路径在下面一行一个、各带「移除」，开关开着而列表为空时不显示状态文字，读不出来的目录在列表下方按「哪条路径、为什么」说出来，密钥读不出来时同样按「哪个名字、为什么」说出来，技能读不出来时按「哪个技能、为什么」说出来（连技能根都读不出来就是「技能目录没读成：为什么」））。主表单最后还有**本机转发**：一个与其他几行同字号的复选框，开启后是三行同构的值 —— **地址**、**用户名**、**密码**，每行都是名称、等宽文字、紧跟其后的复制图标（复制成功后图标短暂变成对勾；**密码那一行显示的不是原文，而是一串固定的圆点**，点复制拿到的仍是真正的密码），值本身既不套框也不能编辑；端口不出现在地址之外，只有监听出问题时错误旁边才多一个「换一个端口」。同步动作（测试连接/预览/立即同步/服务器覆盖本机/撤销恢复/本机覆盖服务器）在「同步内容」末尾排成一行，「放弃改动/保存」在整张卡片最外层。六个同步动作**全部是不带框的文字按钮**，靠颜色分组：**立即同步**是强调色（这一行唯一的着色项，也就是这一行的主操作），**服务器覆盖本机**与**本机覆盖服务器**是警告色（这两个会用一边整体覆盖另一边），**测试连接**、**预览**、**撤销恢复**是普通文字色；悬停时各自浮起一层底色，键盘聚焦时有一圈焦点环。**保存**与确认框的「确定」仍是实心按钮。附加目录的「选择目录」、转发出问题时的「换一个端口」与地址、账号旁的复制图标也都是不带框的轻量按钮。

附加目录那一份的开关说的是「这台电脑带不带这一份」，不是「带哪几个目录」：关掉之后这台电脑一个附加目录都不读、不写，列表原样留在配置里，服务器上那份一个字节不动 —— 与其余几份「关掉的份原样带走」同一条规则，任何地方都不会因此删文件（[0036](docs/decisions/0036-extra-directories-part.md)）。它默认是关的（[0056](docs/decisions/0056-drop-default-model-part.md)）。「选择目录」在满 5 个之后变灰；开关开着、列表为空时这一行不显示状态文字 —— 「不同步」在其余几份里读作「开关关掉了」，而空列表只是「还没指定」。挑目录用的是这台部署已有的对话框（桌面端走它的原生桥，网页端走 workspace 服务）；两者都没弹出来时，会留一个空行让你手打路径。

「同步内容」下面另有一节**手动备份**，两行同构：**导出**和**导入**，各自在名称下面保留一句说明。两行都没有图标，直接点击整行（名称、说明或行内空白处）即可展开或收起下面的小表单；也可以用 Tab 聚焦后按 Enter 或空格操作，正在执行动作时两行禁用（[0070](docs/decisions/0070-backup-clickable-rows.md)）。点导出行展开的是：**这个文件的口令**（自己设一个，不必与上面的同步口令相同 —— 导出用的口令只加密这一个文件，所以把它给别人不会连累服务器上的那份）、**保存到**（一个目录，或一个以 `.prop` 结尾的完整文件名，留空则存到用户主目录；右边是「选择目录」），最后是「导出」与「取消」。点导入行展开的是**文件的口令**加一个**选择文件**：选中的文件名显示在旁边，读不出来会当场说原因；确认后文件里带的每一份都写进本机，替换前的本机 setup 先封存进 `sync/`，可以接着用「撤销恢复」放回去。两行都不动上面的草稿，也不要求先「保存」——导出的内容取的是本机现在真实的样子（[0060](docs/decisions/0060-manual-backup.md)）。

浏览器半边不读 profile 文件、也不说 WebDAV，它只 `fetch` Host 半边在 `ROUTE_PREFIX = '/plugin/webdav-sync'` 之下的路由：

`/status`、`/config`、`/check`、`/sync`、`/preview`、`/restore`、`/undo`、`/upload`、`/dismiss`、`/off`、`/install`、`/export`、`/import`。

主表单最末尾是**本机转发**复选框，开启后用三行同构的文字显示地址与生成的本地 Basic 用户名、密码：每行都是名称（地址 / 用户名 / 密码）、等宽的值、紧跟其后的复制图标，其中密码一行显示的是固定的圆点而不是原文（复制拿到的仍是真密码）。它复用同一份草稿、同一个「放弃改动 / 保存」：`/status` 同时返回 `relay` 的监听状态与本地账号，`/config` 同时保存转发开关和端口并立即应用。没有 `/plugin/webdav-relay/*` 独立路由，也没有独立保存，见下节。

---

## 卡片上的动作

| 按钮 | 路由 | 做什么 | 写哪里 |
| --- | --- | --- | --- |
| **保存** | `/config` | 存下地址、账号与口令、额外请求头、自动同步间隔、同步内容与附加目录列表、本机转发开关与端口；首次开启转发时生成本地账号，保存后立即应用监听状态 | `sync.json`（上游密码按「记住密码」决定是否落盘；加密口令与本地转发账号仍保存在本机） |
| **放弃改动** | 无（只在浏览器半边） | 把表单恢复成上次从 Host 取到的状态 | 不写任何东西 |
| **刷新状态**（「同步内容」标题右边的图标） | `/status`（只读） | 立即重读一次本机状态：两个时间与各份的状态文字刷新，不触发同步、不碰草稿、不覆盖正在输入的口令与密码 | 不写任何东西 |
| **立即同步** | `/sync`（`force: true`） | 跑一次三方分片合并 | 总会写服务器（`force` 覆盖「没什么可说就不写」）；本机只在合并结论需要改它时才写，且被替换的副本先封存进 `sync/` |
| **预览** | `/preview` | 用和真正合并同一套判断，说出每一份会取哪边 | 不写 profile、不写服务器（但会读一次服务器；若那份服务器文件是截断的、且本机有基线，会先留档一份 `-server-damaged`） |
| **测试连接** | `/check` | 到达服务器、报告账号能否读写、服务器上有没有我们的备份、多大、什么时候写的 | 服务器上缺 `dsh-webdav` 文件夹时会创建它（首次同步本来也要建） |
| **服务器覆盖本机** | `/restore` | 不比较谁改了什么，服务器上有的每一份都拿过来（附加目录写回它被指定时的那个绝对路径） | 本机文件；替换前的本机 setup 先封存，供撤销 |
| **本机覆盖服务器** | `/upload` | 覆盖一个**不是我们备份**的服务器文件 | 服务器文件；原文件先留档到 `sync/` |
| **撤销恢复** | `/undo` | 把上次 Restore 换掉的本机 setup 放回去 | 本机文件 |
| **安装缺少的插件** | `/install` | 在 profile 目录跑 `pnpm install` | `node_modules`（同步声明后由本机拉包） |
| **关闭同步**（自动同步选项卡的第一个） | `/off` | 清 `url` 与上游 `password` 并立即停止本机转发监听；保留转发开关、端口及生成的本地账号，服务器上的文件保持原样 | `sync.json`（`sync-state.json` 刻意保留） |
| **知道了** | `/dismiss` | 收掉上次同步的「替换了内容」通知 | `sync-state.json` |
| **导出**（手动备份的「导出」整行） | `/export` | 把上面开着的那几份打成一个用**这个文件自己的口令**加密的 `.prop` 文件，写进你指定的目录或文件名 | 你选的那个目录里的一个文件；本机配置与服务器一个字节不动 |
| **导入**（手动备份的「导入」整行） | `/import` | 用文件的口令打开你选的那个备份，把它带的每一份写进本机（不看你这一台开着哪几份 —— 这是一次明确的动作） | 本机 profile 文件；替换前的 setup 先封存进 `sync/`，可用「撤销恢复」放回去。不同步基线，所以下一次同步会把这套配置推上去 |

「服务器覆盖本机」「本机覆盖服务器」「关闭同步」三个动作都要先在卡片上确认一次（「关闭同步」从「自动同步」选项卡里选，选完弹确认框）；「撤销恢复」只在真的存在一次可撤销的 Restore 时才可用。

「立即同步」在卡片上是带 `force` 调用的（`requestSync({ force: true })`）：即使合并结论与服务器现状完全一致，也会照样写一次服务器。代码里给的理由很直白 —— 一个看起来什么也没做的按钮没人会信。普通同步（包括自动同步的定时器）则相反：结论相同就一个字节都不碰服务器上的文件。

「安装缺少的插件」只在 profile 声明的包名不在 `node_modules` 里时才有意义；`@deepseek-ai/dsh-` 开头的内置包会被跳过，它们随 DSH 一起安装，不属于 profile。当确实缺包时，Host 会把这些包名一并下发（`pendingNames`），卡片上那句「有插件尚未安装」后面列的就是它们，而不是只给一个需要你自己去猜的提示。

安装跑完后，`pnpm` 的输出与那句「安装完成 / 安装未成功」一起留在卡片上，**右上角有一个「关闭」**：日志是证据（失败时真正的原因就在里面），所以它不会自己消失，关不关由你决定；「关闭」只清这一块，不发请求、不动别的字段。见 [0055](docs/decisions/0055-closable-install-report.md)。

---

## 本机转发（给别的 WebDAV 客户端用）

**这是主表单最后的一个开关，不是第二套 WebDAV 配置。** 它让本机上的其他 WebDAV 客户端复用上面已经填好的 `url`、`user`、`password` 与 `headers`。有些客户端没有「额外请求头」这个字段，而服务器恰恰需要 `User-Agent`、`X-Api-Key` 等（见 [0034](docs/decisions/0034-extra-request-headers.md)）；例如 [magpie](https://github.com/yetone/magpie) 的 WebDAV 表单只有地址、账号与密码。

### 开启与复制

1. 在上面的服务器表单里填好 WebDAV 地址、上游账号密码与所需的额外请求头。
2. 勾选主表单末尾的**本机转发**，点整张卡片唯一的**保存**。首次开启并保存时会生成一组本地 Basic 用户名、密码；之后保存、重启或关闭再开启都沿用它们。
3. 点开关下面**地址**那行右边的复制图标，把它复制走，再点**用户名**、**密码**各自的复制图标，把它们填进另一个客户端。这里的账号是本地转发账号，**不是**上游 WebDAV 账号，不需要把真实 WebDAV 密码交给那个客户端。地址与用户名都是只读的：它们由配置推出来，不在这里编辑。三个值都排成「名称 + 等宽文字 + 复制图标」（地址 / 用户名 / 密码），都直接排在那里（不是输入框，也不套框），地址与用户名可以像普通文字一样选中复制；**密码的位置显示一串固定的圆点**，抄不走也截不到，需要时点它右边的复制图标——复制到的是真正的密码（[0067](docs/decisions/0067-part-order-and-backup-icons.md)）。复制被系统拒绝时，图标旁边会说一句「复制没成功，请再点一次」。

地址保留上游基址的路径。例如上游是 `https://dav.example.com/dav/` 时，默认显示：

```
http://127.0.0.1:3426/dav
```

上游没有路径时就是 `http://127.0.0.1:3426`。以卡片实际显示为准，地址中**没有 token**。地址跟随表单草稿预览；改动后要点主「保存」才会应用到监听器。首次保存前还没有本地账号，卡片会提示保存后生成。

### 固定端口与同一个保存

默认端口是 `3426`，保存在 `<profileDir>/.dsh-webdav-sync/sync.json`，不会每次启动随机换一个，也不会在占用时自动挑其他端口。端口出现在地址里，卡片上不再单独列一行：监听有冲突时会显示错误，错误旁边才出现**换一个端口**，按同一个主「保存」生效。改开关或端口都会成为主表单的未保存改动，没有独立转发表单、独立保存或「换一个地址/token」操作。

端口与上游路径共同决定客户端看到的地址；随意更改它们可能让客户端把它当作另一台服务器、重新开始加入流程。显式换端口后要同步更新客户端里的地址。关闭转发只停止监听，保存的端口与本地账号仍保留。

### 认证与转发边界

- **只绑 `127.0.0.1`，且必须通过本地 Basic 认证。** 缺少、错误或不是 Basic 的认证都会得到 `401`（带 Basic challenge），请求到此结束，**不向上游转发**。回环地址不是权限边界，本机其他进程也能访问；本地账号密码才是这扇门的钥匙。
- **客户端的 `Authorization` 只用于进门，绝不透传。** 发往上游的认证复用同步配置的 `user` / `password` 拼 Basic；若额外请求头里显式配置了 `Authorization`，则优先用那一条，不再补 Basic。
- **显式配置的 `User-Agent` 优先。** 额外请求头里配置了 `User-Agent` 时，转发始终使用该值（头名不区分大小写），不让客户端默认 UA 覆盖；未配置时透传客户端 UA，避免上游因客户端类型检查返回 `403 Client type mismatch.`。
- **其余头先配置、后客户端。** 同名时客户端的协议头（`If-Match`、`Depth`、`Content-Type` 等）优先；连接级的逐跳头不透传，`Host` 使用上游地址。其他配置的 `headers`（如 `X-Api-Key`）仍随请求发送。
- **请求与响应按流转发，不转换备份内容。** 方法、请求体、条件头、状态码与 ETag 透传；路径已含上游基路径时不重复拼接，否则补上基路径，查询串保留；指向上游基路径的响应 `Location` 改回本机地址。没有 `.zip` 或 `.prop` 后缀的文件资源路径会统一补 `.prop`，已有这两种后缀则保留；`MKCOL` 与集合型 `PROPFIND` 路径不改名（省略 Depth 按集合处理，Depth 0 的无扩展名未知路径也保持原样）。成功访问产生的别名保存在 profile stateDir，目录型 `PROPFIND` 仅在收到未压缩的 207 响应时，将已知别名的 `href` 还原为客户端原始名称；同一转发器内的 `MOVE` / `COPY` 也会映射 Destination 并维护目标别名。其余 XML 内容与原生 `.prop` 文件名不变，详见 [0050](docs/decisions/0050-relay-propfind-aliases.md) 和 [0049](docs/decisions/0049-relay-collection-and-destination-mapping.md)。

### 本机保存与旧配置

本机开关、端口与生成的账号写在主配置 `<profileDir>/.dsh-webdav-sync/sync.json`（`0600`）的 `relayEnabled` / `relayPort` / `relayUser` / `relayPassword` 字段里，**不上传、不进备份**。本地用户名与密码为了能填进另一个程序会明文显示在卡片中；上游 WebDAV 密码与加密口令仍只以是否已设置下发。能够读取本机配置文件的进程仍可能取得其中的凭据。

**DSH 必须保持运行。** 转发器在 Host 进程里，Host 退出或插件卸载就停止。若上游 `rememberPassword: false`，上游密码只留在本次 Host 内存里，重启后必须在主表单重新输入并保存；本地转发账号虽然仍在，也不能替代上游密码。

旧版 `<profileDir>/.dsh-webdav-relay/relay.json` **不自动读取、不迁移、不删除**，旧 token 地址也不再适用。升级后确认主表单的上游配置，开启转发并保存，再把新的地址与本地账号填入客户端。迁移不需要改动上游数据；开启、关闭、保存转发配置本身不会发起同步，也不会重写或转换服务器上的文件，只有通过认证后的客户端请求才会访问上游。

当前决策见 [0041](docs/decisions/0041-relay-reuses-sync-config.md)；[0040](docs/decisions/0040-local-relay-for-other-clients.md) 保留为历史，其独立配置、token、路由与保存的设计已被取代。

---

## 合并是怎么做的

一次同步是**每份一次的三方合并**，三方是：本机现在、服务器现在、以及上次同步留下的基线。

1. **每份各自哈希**。`hashesOf` 对每一份做 canonical JSON（对象 key 排序）的 SHA-256。因此 YAML 里 key 的书写顺序变化不会造成假变更。
2. **判断每边是否动过**：
   - `changedHere = !first && local[part] !== state.local?.[part]`
   - `changedThere = first || remote.hashes[part] !== state.remote?.[part]`
   - 比的是哈希不是「在不在」—— 只比存在与否会把另一台电脑做的编辑读成「没变」，然后悄悄留下本机更旧的那份。
3. **只本机改** → 推上去。**只服务器改** → 取回来。**两边都没改** → 本机有的就以本机为准，避免只在一侧存在的份被误删。
4. **两边都改** → 比时间：服务器那侧用 `Bundle.created`，本机这侧用文件的 mtime（`patch` 与 `mcp` 份用 `cordis.patch.yml` 的 `mtimeMs`（同一个文件），`plugins` 份用 `package.json` 的 `mtimeMs`，`dirs` 份用它读到的文件里最新的那个 `mtimeMs`，`skills` 份同理，用技能扫描里最新的那个文件的 `mtimeMs`）。本机不早于服务器则本机胜，否则服务器胜。`keys` 份没有文件也没有 mtime，比不出谁新，所以两边都改过时**本机赢**（本机那个值正在被使用，换掉可能当场把模型打断）。**冲突一旦发生，两边都留档到 `sync/`**（`-this-computer` 与 `-server`）。
5. **删除会传播**：服务器上少了某份，本机也把它去掉（`applied[part] = null`）。**五个例外**：`plugins` 份永不删除（它是加载 shell 的东西），`dirs` 份永不删除（见下节），`skills` 份永不删除（技能是手做的东西，同步删不掉它，见上文），`keys` 份永不删除（凭据的「删除」在跨机同步里没有安全语义，见下节），以及首次同步（本机没有基线）不删任何东西。MCP 服务器的行跟其余配置行一样**删除会传播**（一份行列表就是一份行列表）；关掉的份（`syncsPart` 为 false）不删本机的东西，只是不再参与。
6. **每次覆盖前先留档**：本机文件将被改写前，当前的整个 setup 会被封成 `sync/<时间戳>-before-apply.prop`。**第一次同步（以及状态文件丢了之后的第一次）也留这一份**：那种情况下服务器整套配置会被套到本机上，哈希上与「刚加入这台服务器」没法区分，所以插件不猜哪边该赢，而是照常让服务器赢、同时把本机那份封存下来并在通知里**点名它的路径**（`sync/this-computer`），Restore 和 Undo 都能把它放回去。两边本来就一样时不会多出这份副本。见 [0024](docs/decisions/0024-adopting-server-keeps-local.md)。
7. **本机文件只在服务器写成功之后才写**。上传失败的话，这台电脑不会既拿着别人的 setup、又说不清自己那份去哪儿了。
8. **关掉的份会被原样带过上传**：把一份关掉，只是不再动本机的它、也不再从服务器取它，但服务器上那份的存在会被保留 —— 不能因为一台机器关了它，就替还开着它的机器把它删掉。恢复和撤销也一样：一份被关掉，恢复就不会把它写进来，撤销也不会去动它。

### 卡片上的「已改动」是怎么算的

卡片的状态**不去问服务器**（每开一次就发一次请求、解封一次 600,000 轮 PBKDF2，不划算），它只拿上次同步留下的两份基线比：`localChanged` 是「这份文件从上次同步到现在动过没有」，`remoteChanged` 是「两边记录对不上，需要下一次合并去调和」。两者互斥，所以只在本机改一次显示的是「仅本机有改动」，不会是「两边都有改动」。

要说清楚的是：**卡片上的状态不代表服务器现在的真相**。要真知道服务器那边是什么，按「预览」—— 它用同一套合并判断去真读一次服务器，逐份说出会取哪边（见 [0029](docs/decisions/0029-status-says-only-what-it-knows.md)）。

卡片底部那一行左右两个时间是**两件事**：**上次检查**（左边）是宿主**试过**同步（自动同步的每次 tick 都算，哪怕两边一致、一个字节都没写），**上次同步**（右边）只在真换过东西的时候才前进（推上去、从服务器取回某一份、恢复、上传）。所以在「上次检查」在动就说明定时器活着，而「上次同步」停在很久以前只说明这段时间两边一直是一份；升级前的老状态文件没有这个时间，会显示「尚未同步过」。卡片打开着时自己每 15 秒重读一次状态（只读本机文件，不向服务器发请求），否则这两个时间永远停在打开那一刻；「同步内容」标题右边的刷新图标是同一个读取的立即执行，不等到下一个 15 秒，也不碰草稿。见 [0039](docs/decisions/0039-the-card-says-check-and-sync-apart.md)。

写到本机的 YAML 走 `yaml` 的 Document API 而不是「解析成对象再序列化」，所以一个人的注释、缩进、引号风格会在只改了一个 provider 的同步里活下来。合并结论与原文件相同时，`applyPatch` 直接把读到的原始字节还回去 —— YAML 重新序列化不是字节稳定的（`[text, image]` 会被写成 `[ text, image ]`），改写一个什么都没变的文件等于撒谎。

本机写入用「写同目录临时文件再 rename」的方式（`writeAtomic`），断电或崩溃只会留下旧文件或新文件，不会是半个。

### 插件为什么不整目录同步

`node_modules` 不进同步 —— 它是构建产物，动辄几十兆。同步的是**声明**（`dependencies` + `dsh.profile.bundles`），包由本机在 profile 目录里用 `pnpm install` 重新拉取，也就是 DSH 自己的插件管理器用的那条命令。所以清单从别处同步过来之后，需要点一次「安装缺少的插件」。

顺带一提，`applyManifest` 是**镜像**而不是合并这份声明：别的电脑删掉的插件在这里也会从声明里去掉，否则两边永远收敛不了。但这只是文件里少一行，并不会卸载任何包。

### 附加目录：只增不减

`dirs` 这一份和其余几份有三处不同，都是因为**里面是用户自己的文件**：

- **写入只增不减。** 同步会写、会覆盖，但永远不为这条路删掉任何东西。在一台电脑上删掉的笔记会从别处回来；要在所有电脑上删掉，手动删。服务器上这一份整个消失时也一样：本机仍然指定着目录，就把自己的副本推回去，而不是照着删。
- **读不出来不等于空目录。** 目录被删了、盘没挂上、没权限，读取会把这条路径记进 `dirProblems`，并在这一份里**用服务器上的副本原样顶替**这次读取 —— 否则「读不出来」会被读成「这个目录里什么也没有」，下一次推上去就等于替所有人删了整个目录。卡片上会直说哪条路径没读成、为什么。`missing` 再区分「只是不在这台电脑上」（恢复可以建它）与「读不了」（绝不盲写）。
- **有上限，超了整目录不同步。** 最多 5 个目录、每个目录 2000 个文件 / 8 MiB（base64 之前）。`node_modules`、`.git` 与符号链接静默跳过。带半个目录上去比不带更危险，所以超限是拒绝整个目录，而不是截断着带。
- **`~` 开头的路径跟着 DSH 主目录走。** 绝对路径按字面跨机器匹配——两台电脑的用户名或系统不同就对不上；`~/…` 则是名字旅行、各家解析：`~/dsh-model-think-level` 在每台电脑上都指向**它自己**的 `$DSH_HOME`（缺省 `~/.dsh`）下的同名目录，于是两台机器同步的是「同一个目录」，合并照常进行。这是把插件自有数据（`dsh-model-think-level` 的 `key-index.json`、`key-serves.json` 等）带起来的方式，详见 [0079](docs/decisions/0079-home-relative-extra-directories.md)。主目录说不出来的机器报 problem 并让服务器那份原样穿过，什么都不写。
- **目录里的 JSON 文件会贡献密钥名字。** 文件名以 `.json` 结尾、字段名为 `ref` 的非空字符串，按凭据引用收集，与 profile 点名的一起进 `keys` 份——`dsh-model-think-level` 的多密钥索引列着 profile 从不点名的钥匙，这些钥匙的**值**因此也随同步走。不是 JSON 的文件、没有 `ref` 的 JSON，都贡献零；一个解析不到值的名字只是白查一次。

这一份在卡片上和其余几份一样有开关（`dirsEnabled`），只是它默认是关的：关掉之后这台电脑一个附加目录都不读、不写，列表原样留着，服务器上那份也不动 —— 只是「这台不带」，不是「删掉它」。

路径是这一份的数据：`writeDirs` 按备份里的 `path` 写回**同一个目录**，而不是在另一台电脑上另造一个。相对路径、盘符不存在的路径不读也不写，但条目留在这一份里（丢掉它等于替那台电脑删了它）。写回时只动绝对路径；条目里用 `..` 或开头带 `/` 去指到目录以外的文件（`under` 检查）直接不写。见 [0036](docs/decisions/0036-extra-directories-part.md)。

### 技能：扫描就是真相，只增不删

`skills` 这一份是 `$DSH_HOME/skills` 下的技能文件夹（每个含 `SKILL.md` 的一级子目录，停用的技能是 `SKILL.md.disabled`），契约与 `dirs` 大部分相同，两处按技能的实际情况分了岔：

- **写入只增不删**，和 `dirs` 一样：同步会写会覆盖，但永远删不掉一个技能，`null`（合并里「这一份被拿掉」）也什么也不写。
- **目录扫描就是这台电脑的真相。** 这一点与 `dirs` 不同：附加目录的路径没挂载只是暂时不在，不能当作「删了」；技能根永远在 `$DSH_HOME/skills` 下，一个技能文件夹不见了就是用户在这台电脑上删了它。所以删除**在这里生效、但不跨机器**：删掉的技能不会再长回来，服务器上那份原样保留（推回去的是「这份电脑的清单」，不是「所有人的删除」）。反方向同理：技能在这台清空时，服务器那份穿过而**不落盘**（关掉开关是「这台不带」的唯一表达）；而**首次同步**会把服务器的技能写进空机器 —— 那正是这份的用途。
- **读不出来不等于没有技能。** 一个技能读不出来（超过上限、没权限），那一个用服务器的副本原样顶替这次读取，并按「哪个技能、为什么」在卡片上说出来（`skillProblems`，可以像目录、密钥问题一样按签名收起）。连技能根都列不出来（被一个文件占了之类），整份让路：服务器那份原样带过，本机文件一根不碰，卡片说「技能目录没读成：为什么」——和读不出整个凭据库的 `keys` 同一个规矩，宁可这次不同步，也不能把「读不出来」读成「什么都没有」。
- **上限与保护照搬 `dirs`**：每个技能 2000 个文件 / 8 MiB（base64 之前），`node_modules`、`.git` 与符号链接静默跳过，条目里的 `..` 穿越（`under` 检查）直接不写；超限是拒绝那个技能（报它的名字），旁边的技能照常同步。
- **`state.json` 与 `repos/` 不随行。** 那两个是面板记「技能源」的文件，里面全是本机的绝对路径，换台机器就是错的；同步只带走人放进来的技能文件夹。
- **开关默认开**（技能就是配置本身），关掉是「这台不带」：不读也不写任何技能，服务器那份原样带过。见 [0075](docs/decisions/0075-mcp-and-skills-parts.md)。

### MCP 服务器：同一个文件的两个开关

`mcp` 这一份写在 `cordis.patch.yml` 里 —— 和其余 profile 配置**共用同一个文件**，只是在同步里被拆成两份看待：

- **判定按整块。** `name: '@deepseek-ai/dsh-mcp-client'` 的行（带不带 `id`）算 MCP；一个 `insert:` 块里全是这种行，整块算 MCP；混着别种行的块留在其余配置里（按内容整块判：块里一行变了就整块换键，这是配置行本来的语义）。
- **合并逐行做**，和其余配置行一模一样：两边各自加的服务器取并集，两边改了同一台服务器就比时间。**删除照常传播** —— 一份行列表就是一份行列表，删掉的服务器在别的电脑上也会删掉（这是它与技能、密钥「永不删除」契约的区别）。
- **备份文件的形状一个字节都没变**：MCP 行照旧躺在 `patch` 份的行里，升级过的电脑读文件时把它们拆成两份看待（`lift∘join = identity`），所以还没升级的电脑看到的仍是它认识的那个文件 —— 一行都不会因为「不认识 `mcp` 这一份」而被丢掉。
- **开关默认开**（这些行一直都在跟着走，单独一个开关是让你能把「这台的服务器列表」留下来），关掉是「这台不带」：本机的行不外传，服务器那份原样带过。见 [0075](docs/decisions/0075-mcp-and-skills-parts.md)。

### API 密钥：跟着点它名的那一份走

DSH 的 profile 里没有密钥，只有密钥的名字。所以 `keys` 这一份不是一个文件，而是一张「名字 → 值」的表，由 DSH 的凭据服务（`ctx.credentials`）读写：

- **发哪些名字，从配置里读。** `credentialRefs` 把即将发出的那几份递归走一遍，凡遇到 `apiKeyEnv` / `secretEnv`（`CREDENTIAL_FIELDS`，取自 `llm-pi-ai`、`llm-deepseek-api-key`、`web-search-deepseek`、`webhook-github` 四个 schema）且值非空，就记下这个名字。凭据服务本身不能枚举引用名（它只有 `resolve` / `describe` / `set` / `unset`，`listRecords` 覆盖的是 OAuth 的 `records` 那一半），所以只能反过来从配置里问。好处是**密钥与点它名的那一份同生同灭**：`models` 不发，里面的 provider 名字也就不发，不需要第二套「哪些该发」的判断。
- **只发托管存储里的值。** `readKeys` 对每个名字 `resolve` 一次，只有 `source === 'file'`（也就是 `$DSH_HOME/.credentials.yaml` 的 `refs:`）才收进这一份。环境导出的值属于「谁启动了 DSH」，不属于这台电脑存的配置 —— 把它抄到另一台电脑上等于替那台机器做了个它没做过的决定。想让存储里的值成为生效值并发出去，就在 shell 里 unset 它（这正是服务自己「环境赢」的规则）。解析不到值的名字**跳过**而不是报错：很多 profile 点着一个没人登录过的 provider，「这个键也不在」不是同步失败。解析**本身**失败才报，因为读不了的存储不能长得像空存储。
- **只写不删，写之前先留档。** `applyKeys` 对每个名字先 `resolve`，值已经相同就跳过（被只读层遮住时 `set` 会拒绝，而「同一个值说了第二遍」不该报成失败）；真正要覆盖旧值时，先让引擎把本机现状封进 `sync/before-apply`，撤销才有东西可放回。`null`（合并里「这一份被拿掉」的表达）什么也不写 —— 跨机同步分不清「这台删了」与「那台没有」，删密钥是人在设置页做的事。
- **开关默认开。** 关掉之后这台电脑既不读也不写密钥，服务器上那份原样带过（不是删掉）。秘密落到别人磁盘上的承诺，和配置落过去不是同一个承诺，所以它有自己的开关。
- **宿主没有凭据服务时照实说。** 用 `ctx.get('credentials')` 结构化地取，取不到就是 `undefined`，卡片按 `keyStoreProblem` 说「本机存的 API 密钥没读成」，而不是安静地少发一份。它不进 `inject`：没有凭据服务的宿主是可用状态，其余几份照常同步。

见 [0054](docs/decisions/0054-sync-api-keys.md)。

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
- **API 密钥只发托管存储里的值，且只写不删。** 密钥进这一份是因为 profile 里只有名字、没有值（只发配置会让另一台电脑每个 provider 都报 `MISSING_CREDENTIAL`）。它仍然是先封后发：和其余几份一样躺在同一个密文文件里，服务器看不到值。环境导出的键不发（那属于启动 DSH 的那个 shell，不属于这台电脑存的配置）；解析不到的名字跳过而不是报错；任何同步都不会删掉一个密钥 —— `applyKeys` 收到 `null` 直接返回。写之前先留档，撤销才有东西放回。见 [0054](docs/decisions/0054-sync-api-keys.md)。
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

同步的全部在 profile 的 `.dsh-webdav-sync/` 之下：

| 路径 | 权限 | 内容 |
| --- | --- | --- |
| `<profileDir>/.dsh-webdav-sync/sync.json` | `0600` | 同步与本机转发的主配置，**含加密口令、选择记住的上游 WebDAV 密码、转发开关/端口与生成的本地 Basic 账号密码**；整个配置文件不上传 |
| `<profileDir>/.dsh-webdav-sync/sync-state.json` | `0600` | 同步状态：服务器版本、各份哈希、上次通知、可撤销的 Restore、上次失败原因 |
| `<profileDir>/.dsh-webdav-sync/sync-server.prop` | `0600` | 上次读/写的服务器正文缓存（让「只本机变过」的同步不必下载它正要覆盖的文件） |
| `<profileDir>/.dsh-webdav-sync/sync/` | `0700` | 被替换掉的副本。每个 tag 保留最新 5 份 |

profile 目录的解析顺序（与 `dsh-git-branch` 一致）：`profileDir` 配置项（必须是绝对路径）→ `$DSH_PROFILE_DIR` → `<home>/profiles/<name>`，其中 `<home>` 取 `$DSH_HOME`（须是绝对路径）否则 `~/.dsh`，`<name>` 取 `$DSH_PROFILE` 否则 `desktop`。空字符串一律当作没设。

前四份切自 profile 的两个文件：`cordis.patch.yml`（`models`、`patch`、`mcp` 三份都出自它 —— `mcp` 的行就是这个文件里的行，只是被单独看待）与 `package.json`（`plugins`）。第五份（`skills`）是 `$DSH_HOME/skills` 下的技能文件夹，跟着备份走、写回同一个根。第六份（`dirs`）是你在卡片上指定的附加目录，内容跟着备份走，落在同一个路径。第七份（`keys`）不来自任何文件，它从 DSH 的凭据服务里读出上面几份点名的那些密钥 —— 那个存储（`$DSH_HOME/.credentials.yaml`）不归本插件管，同步只经 `resolve` / `set` 读写它，从不自己动那个文件。

份的顺序只有一处定义：`src/wire.ts` 的 `PARTS`（`models`、`keys`、`plugins`、`mcp`、`skills`、`patch`、`dirs`）。卡片上「同步内容」的行序、合并时走它们的次序、以及 `/status` 与导出文件的份清单，都读这同一个数组，所以「密钥排第二」只是改了这一个数组，界面没有第二套排序（[0067](docs/decisions/0067-part-order-and-backup-icons.md)）。上面那张表按「取自」归类，不是行序。

---

## 开发

```bash
pnpm install
pnpm test          # vitest run —— 406 个测试
pnpm run typecheck # tsc -p tsconfig.client.json --noEmit
pnpm run build:all # pnpm run build && pnpm run build:client
```

`package.json` 里的脚本照抄如下：`build` = `tsc -p tsconfig.json`，`build:client` = `tsdown`，`build:all` = `pnpm run build && pnpm run build:client`，`watch:client` = `tsdown --watch`，`test` = `vitest run`，`typecheck` = `tsc -p tsconfig.client.json --noEmit`，`prepublishOnly` = `pnpm run typecheck && pnpm test && pnpm run build:all`。

`lib/` 是**构建产物**（`build` 出 Node 半边，`build:client` 出浏览器 bundle），已 gitignore，不进仓库；它通过 `prepublishOnly` 进入 npm tarball。要跑 `pnpm run build:all` 之后 `lib/` 才有东西。发布时 sourcemap 不进 tarball（`files` 里有 `"!lib/**/*.map"`），所以浏览器 bundle 用 `sourcemap: 'hidden'` 打：本地构建仍有 map 可用，产物里则不会留下一个指向已排除文件的 `sourceMappingURL` 注释（见 [0014](docs/decisions/0014-hidden-sourcemap.md)）。

环境要求：`engines.node >= 22.19`，包管理器 `pnpm@11.8.0`（`packageManager` 字段）。运行时依赖只有 `yaml`；Host 半边依赖 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/schemastery` 作为 peerDependencies。

测试分布：`tests/engine.spec.ts`（67）、`tests/client-card.spec.ts`（50）、`tests/dav.spec.ts`（49）、`tests/relay.spec.ts`（46）、`tests/state.spec.ts`（40）、`tests/index.spec.ts`（33）、`tests/store.spec.ts`（30）、`tests/keys.spec.ts`（26）、`tests/crypto.spec.ts`（22）、`tests/dirs.spec.ts`（16）、`tests/relay-host.spec.ts`（8）、`tests/install.spec.ts`（7）、`tests/part-rows.spec.tsx`（6）、`tests/relay-panel.spec.tsx`（6），共 406 例。

---

## 决策记录

本仓库非平凡变更的取舍记录在 [`docs/decisions/`](docs/decisions/README.md)，每条含背景、决策（含被否决的备选）与影响两面。其中 [0029](docs/decisions/0029-status-says-only-what-it-knows.md) 说明卡片上「已改动」的算法与它**不代表**服务器真相的理由，[0030](docs/decisions/0030-review-findings-not-changed.md) 记录一次对抗性源码审查里**刻意不改**的那几条（以及每一条为什么）—— 那一篇的末尾有一张复现到决策的对照表。

---

## 许可

MIT © GaoHu1997（奋斗的小高）

---

## English

`dsh-webdav-sync` keeps a DSH profile the same across computers through a WebDAV folder. It syncs seven parts — the model catalog (the `llm-pi-ai` row of `cordis.patch.yml`), the remaining profile-patch rows, the MCP server rows of that same file (they are the `@deepseek-ai/dsh-mcp-client` entries: kept in the wire's `patch` field exactly as before so an older computer reads the very same file and drops nothing, but merged and switched on their own), the installed-plugin list from `package.json`, the skill folders under `$DSH_HOME/skills` (their files travel inside the same sealed backup and a restore writes them back under the same root, add-only — a sync never deletes a skill), the extra directories you pick in the card (their files travel inside the same sealed backup and a restore writes them back to the very same absolute path, add-only, switched off until you tick it in the 同步内容 list), and the API keys those parts name: a DSH profile only ever holds a credential's *name* (`apiKeyEnv` / `secretEnv`), so the value is read from DSH's credential store and carried along, sealed under the same passphrase, never deleted. The default-model row (`agent-default-model`) stays on each computer: it changes with every model switch, so carrying it would turn each switch into a sync of its own.

The whole backup is sealed on this computer with a passphrase (AES-256-GCM under a PBKDF2-SHA256 key, 600000 iterations) before it is uploaded, so the server only ever holds ciphertext at `<address>/dsh-webdav/dsh-profile.prop`. Each part is hashed on its own and merged three-way against the last synced baseline: one side changed wins, both changed keeps the newer and files the loser under `<profileDir>/.dsh-webdav-sync/sync/`, and every copy that gets replaced is sealed aside first. Removals propagate — except the plugin list, the extra directories and the API keys, which are never removed.

The design is ported from [magpie](https://github.com/yetone/magpie)'s `internal/davsync` (Go → TypeScript, syncing DSH profile rows instead of magpie's own configuration). The WebDAV password and the passphrase live in `<profileDir>/.dsh-webdav-sync/sync.json` at mode 0600 and are never written into `cordis.patch.yml` — the patch is itself one of the things that travels — and never sent to the browser, which only receives `passwordSet` / `passphraseSet` booleans.

A file on the server that is not a backup of ours is never silently overwritten; restoring from it or writing over it are explicit actions.

The optional loopback forwarder is the final checkbox in the same form, with the same Save button — not another WebDAV configuration. It reuses the sync's `url`, `user`, `password`, and extra `headers`. Once enabled and saved, small text shows the local address, persisted port (default `3426`), and a generated local Basic username/password; address and credentials can each be copied. For an upstream address such as `https://dav.example.com/dav/`, use `http://127.0.0.1:3426/dav` and the local credentials in the other client. There is no path token. The port is never randomized automatically: use the explicit change-port button, save with the main form, then update the client's address. The generated account is kept across saves and restarts in `<profileDir>/.dsh-webdav-sync/sync.json`, never uploaded.

The relay binds only `127.0.0.1`. Missing or incorrect local Basic authentication gets `401` and is not forwarded. Client `Authorization` is consumed locally and never sent upstream: upstream authentication uses the sync's Basic credentials unless an explicit extra `Authorization` header overrides them. Other client protocol headers take precedence over configured headers; methods, request bodies, conditional headers and status codes stream through without interpreting WebDAV, and upstream `Location` headers are mapped back to the relay. DSH must remain running. With upstream `rememberPassword: false`, the upstream password must be entered again after a Host restart even though the local account remains saved. Old `<profileDir>/.dsh-webdav-relay/relay.json` is not read, migrated or deleted automatically; reconfigure clients with the new displayed address and local account. Saving or toggling the relay does not sync, rewrite or convert upstream data; authenticated client requests still perform their requested WebDAV operations. [0041](docs/decisions/0041-relay-reuses-sync-config.md) supersedes the separate configuration, token, routes and Save design in historical [0040](docs/decisions/0040-local-relay-for-other-clients.md). License: MIT.
