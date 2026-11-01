/**
 * The card's copy. `zh` is the key source: `en` is declared as
 * `Record<WebdavSyncKey, string>`, so a key added here without a translation
 * fails the build instead of surfacing a raw key in the panel.
 *
 * Placeholders are `{name}` — resolved by the locale runtime, never by `String.replace`.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

export const NS = 'webdav-sync'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'webdav-sync': WebdavSyncKey
  }
}

export type WebdavSyncKey =
  | 'sectionTitle'
  | 'cardSummaryOff'
  | 'cardSummaryOn'
  | 'cardSummaryIncomplete'
  | 'addressLegend'
  | 'urlLabel'
  | 'userLabel'
  | 'passwordLabel'
  | 'passphraseLabel'
  | 'passphraseHint'
  | 'headersLabel'
  | 'headersPlaceholder'
  | 'rememberPassword'
  | 'autoLegend'
  | 'autoManual'
  | 'autoEvery'
  | 'autoHour'
  | 'autoOff'
  | 'partsLegend'
  | 'partModels'
  | 'partModelsHint'
  | 'partPlugins'
  | 'partPluginsHint'
  | 'partPatch'
  | 'partPatchHint'
  | 'partKeys'
  | 'partKeysHint'
  | 'partDirs'
  | 'partDirsHint'
  | 'partMcp'
  | 'partMcpHint'
  | 'partSkills'
  | 'partSkillsHint'
  | 'partSynced'
  | 'partOnlyHere'
  | 'partOnlyThere'
  | 'partBoth'
  | 'partUnsaved'
  | 'lastCheck'
  | 'neverChecked'
  | 'lastSync'
  | 'neverSynced'
  | 'refreshStatus'
  | 'statusStale'
  | 'noticeTitle'
  | 'noticeHere'
  | 'noticeThere'
  | 'noticeSaved'
  | 'noticeRestored'
  | 'noticeDismiss'
  | 'save'
  | 'saving'
  | 'saveLegend'
  | 'discard'
  | 'check'
  | 'preview'
  | 'syncNow'
  | 'restore'
  | 'undo'
  | 'upload'
  | 'install'
  | 'working'
  | 'reloadHint'
  | 'pendingInstall'
  | 'pendingInstallAction'
  | 'installOk'
  | 'installFailed'
  | 'outputClose'
  | 'confirmRestore'
  | 'confirmUpload'
  | 'confirmOff'
  | 'yes'
  | 'no'
  | 'previewEmpty'
  | 'previewTitle'
  | 'promptDismiss'
  | 'takeBoth'
  | 'takeLocal'
  | 'takeRemote'
  | 'takeNewerLocal'
  | 'takeNewerRemote'
  | 'unavailable'
  | 'partOff'
  | 'partOffHint'
  | 'chooseDir'
  | 'dirPlaceholder'
  | 'dirRemove'
  | 'dirProblem'
  | 'skillProblem'
  | 'skillStoreProblem'
  | 'keyProblem'
  | 'keyStoreProblem'
  | 'keysWritten'
  | 'lastSyncFailed'

  // ---- manual backup: a file that leaves the computer, and one that arrives ----
  | 'backupLegend'
  | 'exportTitle'
  | 'exportHint'
  | 'exportAction'
  | 'importTitle'
  | 'importHint'
  | 'importAction'
  | 'exportPassphraseLabel'
  | 'exportPassphraseHint'
  | 'exportDirLabel'
  | 'exportDirHint'
  | 'exportDirPlaceholder'
  | 'exportDirChoose'
  | 'exportConfirm'
  | 'exportCancel'
  | 'importPassphraseLabel'
  | 'importPassphraseHint'
  | 'importFileLabel'
  | 'importFileHint'
  | 'importFileChoose'
  | 'importConfirm'
  | 'importCancel'
  | 'exportDone'
  | 'importDone'
  | 'importSame'
  | 'importPending'
  | 'importNoFile'

  // ---- the forwarder: a switch on this configuration, in its own words ----
  | 'relayLegend'
  | 'relayEnable'
  | 'relayListening'
  | 'relayIdle'
  | 'relayNoTarget'
  | 'relayNextPort'
  | 'relayAccountLater'
  | 'relayAddressLabel'
  | 'relayUserLabel'
  | 'relayPasswordLabel'
  | 'relayCopyAddress'
  | 'relayCopyUser'
  | 'relayCopyPassword'
  | 'relayCopied'
  | 'relayCopyFailed'

/** Chinese copy — the source dictionary. */
export const zh: Record<WebdavSyncKey, string> = {
  sectionTitle: 'WebDAV 同步',

  cardSummaryOff: 'WebDAV 同步：未开启',
  cardSummaryOn: 'WebDAV 同步：{url}',
  cardSummaryIncomplete: 'WebDAV 同步：地址已填，口令待填写',

  addressLegend: '服务器',
  urlLabel: 'WebDAV 地址',
  userLabel: '用户名',
  passwordLabel: '密码',
  passphraseLabel: '口令',
  passphraseHint: '口令在文件离开本机前用来加密，服务器看不到内容；不要与 WebDAV 密码用同一个。',
  headersLabel: '额外请求头',
  headersPlaceholder: 'User-Agent: Zotero/7.0\nAuthorization: Bearer xxxxx',
  rememberPassword: '保存密码',

  autoLegend: '自动同步',
  autoManual: '手动同步',
  autoEvery: '{n} 分钟',
  autoHour: '{n} 小时',
  autoOff: '关闭同步',

  partsLegend: '同步内容',
  partModels: '模型供应商与模型',
  partModelsHint: '有哪些供应商、各自提供哪些模型、API key 从哪里读。',
  partPlugins: '已安装插件',
  partPluginsHint: '插件清单、加载顺序和已识别的插件配置。日志与缓存不传，插件包由每台机器自己安装。',
  partPatch: '其余 profile 配置',
  partPatchHint: '权限预设、界面设置、insert 块等其余配置。',
  partKeys: 'API 密钥',
  partKeysHint: '本机存的 API 密钥，按供应商名字对应；两边都改过时以本机为准，同步不会删掉任何密钥。',
  partMcp: 'MCP 服务器',
  partMcpHint: 'MCP 服务器的连接配置：连哪些服务器、各自的地址和密钥。跟其余配置一样逐条合并。',
  partSkills: '技能',
  partSkillsHint: '技能文件夹（$DSH_HOME/skills 下），连里面的文件一起同步；同步不会删掉任何技能。',
  partDirs: '附加目录',
  partDirsHint: 'profile 之外的目录，连里面的文件一起同步；路径跟着这份配置走，恢复时写回同一个目录。以 ~ 开头的路径按每台电脑自己的 DSH 主目录（$DSH_HOME，默认 ~/.dsh）解析，适合同步插件自己的数据目录，比如 ~/dsh-model-think-level。',
  partSynced: '已一致',
  partOnlyHere: '仅本机有改动',
  partOnlyThere: '仅服务器有改动',
  partBoth: '两边都有改动',
  partUnsaved: '待保存',

  lastCheck: '上次检查：{at}',
  neverChecked: '尚未检查过',
  lastSync: '上次同步：{at}',
  neverSynced: '尚未同步过',
  refreshStatus: '刷新状态',
  statusStale: '状态刷新失败，显示的时间可能已过期；将自动重试。',

  noticeTitle: '上次同步替换了内容',
  noticeHere: '服务器覆盖了本机：{parts}',
  noticeThere: '本机覆盖了服务器：{parts}',
  noticeSaved: '被替换的副本保存在：{dir}',
  noticeRestored: '这次是把服务器恢复到本机。',
  noticeDismiss: '知道了',

  save: '保存',
  saving: '保存中…',
  saveLegend: '保存以上设置（服务器、自动同步、同步内容）',
  discard: '放弃改动',
  check: '测试连接',
  preview: '预览',
  syncNow: '立即同步',
  restore: '服务器覆盖本机',
  undo: '撤销恢复',
  upload: '本机覆盖服务器',
  install: '安装缺少的插件',
  working: '处理中…',
  reloadHint: '配置文件有改动，重新加载界面后生效。',
  pendingInstall: '有插件尚未安装：{names}',
  pendingInstallAction: '安装',
  installOk: '安装完成。',
  installFailed: '安装未成功，请看下面的输出。',
  outputClose: '关闭',

  confirmRestore: '用服务器上的配置覆盖本机？本机现在的配置会先另存一份，之后可以撤销。',
  confirmUpload: '用本机配置覆盖服务器上的文件？服务器上现有的文件会先另存一份。',
  confirmOff: '关闭同步？服务器上的文件不会被删除。',
  yes: '确定',
  no: '取消',

  previewEmpty: '两边一致，同步不会有任何改动。',
  previewTitle: '这次同步会这样处理',
  promptDismiss: '移除这条提示',
  takeBoth: '两边都改过，密钥合到一起（同名的保留本机的一份）',
  takeLocal: '推送本机的一份',
  takeRemote: '取回服务器的一份',
  takeNewerLocal: '两边都改过，保留本机较新的一份',
  takeNewerRemote: '两边都改过，保留服务器较新的一份',

  unavailable: '暂时不可用',
  partOff: '不同步',
  partOffHint: '关掉之后，本机不会再动这一份，也不会把它推给别的机器。',

  chooseDir: '选择目录',
  dirPlaceholder: '绝对路径，或 ~ 开头按 DSH 主目录解析',
  dirRemove: '移除',
  dirProblem: '「{path}」这个目录没读成：{message}',
  skillProblem: '「{name}」这个技能没读成：{message}',
  skillStoreProblem: '技能目录没读成：{message}',
  keyProblem: '「{ref}」这个 API 密钥没读成：{message}',
  keyStoreProblem: '本机存的 API 密钥没读成：{message}',
  keysWritten: '这次同步把服务器上的密钥存到了这里：{refs}',
  lastSyncFailed: '上次同步没成功：{message}',

  backupLegend: '手动备份',
  exportTitle: '导出',
  exportHint: '按已保存的同步项生成加密备份；点这一行展开，填好口令后确认',
  exportAction: '导出',
  importTitle: '导入',
  importHint: '导入备份；插件配置与 API 密钥遵守各自开关，其余内容按文件替换',
  importAction: '导入',
  exportPassphraseLabel: '这个文件的口令',
  exportPassphraseHint: '这个口令只用来加密这份文件，与上面的同步口令无关；带到另一台电脑时要一起记住它。',
  exportDirLabel: '保存到',
  exportDirHint: '填写绝对目录，或以 .prop 结尾的完整文件路径；留空保存到运行 DSH 的电脑用户主目录。不会触发浏览器下载，也不会覆盖已有文件。',
  exportDirPlaceholder: '留空保存到用户主目录',
  exportDirChoose: '选择目录',
  exportConfirm: '生成备份文件',
  exportCancel: '取消',
  importPassphraseLabel: '文件的口令',
  importPassphraseHint: '输入导出这份文件时用的那个口令。',
  importFileLabel: '要导入的文件',
  importFileHint: '选一个从本插件导出的 .prop 文件。',
  importFileChoose: '选择文件',
  importConfirm: '导入',
  importCancel: '取消',
  exportDone: '备份文件已生成：{file}（{size}，含{parts}）。文件在运行 DSH 的电脑上，请按此路径查找，不在浏览器下载列表中。',
  importDone: '已导入：{parts}。',
  importSame: '已是最新：{parts} 和文件里的一样，没有改动。',
  importPending: '文件里的插件还没安装，请在下面点「安装缺少的插件」。',
  importNoFile: '还没有选择文件。',

  relayLegend: '本机转发',
  relayEnable: '启用本机转发',
  relayListening: '正在转发',
  relayIdle: '没有在转发',
  relayNoTarget: '先在上面把 WebDAV 地址填好',
  relayNextPort: '换一个端口',
  relayAccountLater: '保存一次后生成给客户端用的账号密码。',
  relayAddressLabel: '地址',
  relayUserLabel: '用户名',
  relayPasswordLabel: '密码',
  relayCopyAddress: '复制地址',
  relayCopyUser: '复制用户名',
  relayCopyPassword: '复制密码',
  relayCopied: '已复制',
  relayCopyFailed: '复制没成功，请再点一次',
}

/** English copy, complete by construction. */
export const en: Record<WebdavSyncKey, string> = {
  sectionTitle: 'WebDAV sync',

  cardSummaryOff: 'WebDAV sync: off',
  cardSummaryOn: 'WebDAV sync: {url}',
  cardSummaryIncomplete: 'WebDAV sync: address set, no passphrase yet',

  addressLegend: 'Server',
  urlLabel: 'WebDAV address',
  userLabel: 'User name',
  passwordLabel: 'Password',
  passphraseLabel: 'Passphrase',
  passphraseHint: 'It seals the file before it leaves this computer, so the server cannot read it. Do not reuse the password above.',
  headersLabel: 'Extra request headers',
  headersPlaceholder: 'User-Agent: Zotero/7.0\nAuthorization: Bearer xxxxx',
  rememberPassword: 'Remember the password',

  autoLegend: 'Sync by itself',
  autoManual: 'By hand',
  autoEvery: 'Every {n} min',
  autoHour: 'Every {n} h',
  autoOff: 'Off',

  partsLegend: 'What is synced',
  partModels: 'Model providers and models',
  partModelsHint: 'Which providers there are, what models each offers, and where their API keys come from.',
  partPlugins: 'Installed plugins',
  partPluginsHint: 'Plugin list, load order and recognized plugin settings. Logs and caches stay behind; each computer installs the packages.',
  partPatch: 'Other profile configuration',
  partPatchHint: 'Permission presets, interface settings, insert blocks, and the rest.',
  partKeys: 'API keys',
  partKeysHint: 'The API keys stored on this computer, one per provider name; when both sides changed, this computer’s copy wins, and a sync never deletes a key.',
  partMcp: 'MCP servers',
  partMcpHint: 'The MCP server connections: which servers to talk to, and their addresses and keys. Merged entry by entry like the rest of the profile.',
  partSkills: 'Skills',
  partSkillsHint: 'The skill folders (under $DSH_HOME/skills), carried with the files inside them; a sync never deletes a skill.',
  partDirs: 'Extra directories',
  partDirsHint: 'Directories outside the profile, carried with the files inside them; the paths travel with this configuration, and a restore writes back into the same directory. A path starting with ~ resolves against each computer’s own DSH home ($DSH_HOME, ~/.dsh by default) — the way to sync a plugin’s own data directory, such as ~/dsh-model-think-level.',
  partSynced: 'In step',
  partOnlyHere: 'Changed here only',
  partOnlyThere: 'Changed on the server only',
  partBoth: 'Changed on both',
  partUnsaved: 'Not saved yet',

  lastCheck: 'Last check: {at}',
  neverChecked: 'Never checked yet',
  lastSync: 'Last sync: {at}',
  neverSynced: 'Never synced yet',
  refreshStatus: 'Refresh status',
  statusStale: 'Status refresh failed; the displayed times may be stale. Retrying automatically.',

  noticeTitle: 'The last sync replaced something',
  noticeHere: 'The server replaced this computer: {parts}',
  noticeThere: 'This computer replaced the server: {parts}',
  noticeSaved: 'The replaced copies are kept in {dir}',
  noticeRestored: 'This one took the server’s setup over this computer’s.',
  noticeDismiss: 'Got it',

  save: 'Save',
  saving: 'Saving…',
  saveLegend: 'Save the settings above (server, auto sync, what is synced)',
  discard: 'Discard',
  check: 'Test the connection',
  preview: 'Preview',
  syncNow: 'Sync now',
  restore: 'Server onto here',
  undo: 'Undo restore',
  upload: 'Here onto server',
  install: 'Install the missing plugins',
  working: 'Working…',
  reloadHint: 'Configuration files changed: reload the interface to pick them up.',
  pendingInstall: 'Plugins declared but not installed: {names}',
  pendingInstallAction: 'Install',
  installOk: 'Installed.',
  installFailed: 'The install did not finish; the output is below.',
  outputClose: 'Close',

  confirmRestore: 'Take the server’s setup over this computer’s? What is here now is kept aside first, so it can be undone.',
  confirmUpload: 'Write this computer’s setup over the file on the server? The file there is kept aside first.',
  confirmOff: 'Stop syncing? The file on the server is not deleted.',
  yes: 'Yes',
  no: 'Cancel',

  previewEmpty: 'Both sides agree: a sync would change nothing.',
  previewTitle: 'A sync would do this',
  promptDismiss: 'Dismiss this message',
  takeBoth: 'Both changed: the keys are merged (this computer’s value wins for the same name)',
  takeLocal: 'Push this computer’s copy',
  takeRemote: 'Bring in the server’s copy',
  takeNewerLocal: 'Both changed: keep this computer’s as the newer one',
  takeNewerRemote: 'Both changed: keep the server’s as the newer one',

  unavailable: 'Not available',
  partOff: 'Not synced',
  partOffHint: 'Off: this computer neither changes this part nor hands it to the others.',

  chooseDir: 'Choose directory',
  dirPlaceholder: 'Absolute path, or ~/ for the DSH home',
  dirRemove: 'Remove',
  dirProblem: 'Could not read the directory {path}: {message}',
  skillProblem: 'Could not read the skill {name}: {message}',
  skillStoreProblem: 'Could not read the skills directory: {message}',
  keyProblem: 'Could not read the API key {ref}: {message}',
  keyStoreProblem: 'Could not read the stored API keys: {message}',
  keysWritten: 'This sync stored the server’s keys here: {refs}',
  lastSyncFailed: 'The last sync did not go through: {message}',

  backupLegend: 'Manual backup',
  exportTitle: 'Export',
  exportHint: 'Use the saved part switches to make an encrypted backup; click this row, enter a passphrase, then choose Generate backup file',
  exportAction: 'Export',
  importTitle: 'Import',
  importHint: 'Import a backup; plugin settings and API keys follow their switches, while other content follows the file',
  importAction: 'Import',
  exportPassphraseLabel: 'Passphrase for this file',
  exportPassphraseHint: 'It seals this file only, not the sync above; you will need it again on the other computer.',
  exportDirLabel: 'Save to',
  exportDirHint: 'An absolute directory or a full file path ending in .prop; blank saves to the home directory on the computer running DSH. No browser download is started and existing files are not overwritten.',
  exportDirPlaceholder: 'Blank saves to your home directory',
  exportDirChoose: 'Choose directory',
  exportConfirm: 'Generate backup file',
  exportCancel: 'Cancel',
  importPassphraseLabel: 'Passphrase for the file',
  importPassphraseHint: 'The one used when this file was exported.',
  importFileLabel: 'File to import',
  importFileHint: 'Pick a .prop file this plugin exported.',
  importFileChoose: 'Choose file',
  importConfirm: 'Import',
  importCancel: 'Cancel',
  exportDone: 'Backup file created: {file} ({size}, with {parts}). Find it at this path on the computer running DSH, not in the browser downloads list.',
  importDone: 'Imported: {parts}.',
  importSame: 'Already up to date: {parts} match the file, so nothing changed.',
  importPending: 'The file declares plugins that are not installed; use Install below.',
  importNoFile: 'No file chosen yet.',

  relayLegend: 'Forwarding on this computer',
  relayEnable: 'Forward for other programs on this computer',
  relayListening: 'Forwarding',
  relayIdle: 'Not forwarding',
  relayNoTarget: 'Fill in the WebDAV address above first',
  relayNextPort: 'Another port',
  relayAccountLater: 'The account for the client is made on the first save.',
  relayAddressLabel: 'Address',
  relayUserLabel: 'User name',
  relayPasswordLabel: 'Password',
  relayCopyAddress: 'Copy address',
  relayCopyUser: 'Copy user name',
  relayCopyPassword: 'Copy password',
  relayCopied: 'Copied',
  relayCopyFailed: 'Could not copy — try again',
}
