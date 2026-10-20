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
  | 'cardSummaryUnset'
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
  | 'partDefaults'
  | 'partDefaultsHint'
  | 'partPlugins'
  | 'partPluginsHint'
  | 'partPatch'
  | 'partPatchHint'
  | 'partDirs'
  | 'partDirsHint'
  | 'partSynced'
  | 'partOnlyHere'
  | 'partOnlyThere'
  | 'partBoth'
  | 'lastCheck'
  | 'neverChecked'
  | 'lastSync'
  | 'neverSynced'
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
  | 'confirmRestore'
  | 'confirmUpload'
  | 'confirmOff'
  | 'yes'
  | 'no'
  | 'previewEmpty'
  | 'previewTitle'
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
  cardSummaryUnset: 'WebDAV 同步：已开启，地址待填写',

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
  partDefaults: '默认模型',
  partDefaultsHint: '新开会话时默认用哪个供应商、哪个模型。',
  partPlugins: '已安装插件',
  partPluginsHint: '装了哪些插件、按什么顺序加载。插件包本身不传，每台机器自己安装。',
  partPatch: '其余 profile 配置',
  partPatchHint: 'MCP 服务器、权限预设、界面设置、insert 块等其余配置。',
  partDirs: '附加目录',
  partDirsHint: 'profile 之外的目录，连里面的文件一起同步；路径跟着这份配置走，恢复时写回同一个目录。',
  partSynced: '已一致',
  partOnlyHere: '仅本机有改动',
  partOnlyThere: '仅服务器有改动',
  partBoth: '两边都有改动',

  lastCheck: '上次检查：{at}',
  neverChecked: '尚未检查过',
  lastSync: '上次同步：{at}',
  neverSynced: '尚未同步过',

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

  confirmRestore: '用服务器上的配置覆盖本机？本机现在的配置会先另存一份，之后可以撤销。',
  confirmUpload: '用本机配置覆盖服务器上的文件？服务器上现有的文件会先另存一份。',
  confirmOff: '关闭同步？服务器上的文件不会被删除。',
  yes: '确定',
  no: '取消',

  previewEmpty: '两边一致，同步不会有任何改动。',
  previewTitle: '这次同步会这样处理',
  takeLocal: '推送本机的一份',
  takeRemote: '取回服务器的一份',
  takeNewerLocal: '两边都改过，保留本机较新的一份',
  takeNewerRemote: '两边都改过，保留服务器较新的一份',

  unavailable: '暂时不可用',
  partOff: '不同步',
  partOffHint: '关掉之后，本机不会再动这一份，也不会把它推给别的机器。',

  chooseDir: '选择目录',
  dirPlaceholder: '这个目录的绝对路径',
  dirRemove: '移除',
  dirProblem: '「{path}」这个目录没读成：{message}',

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
  relayCopyFailed: '复制没成功，请手动选中复制',
}

/** English copy, complete by construction. */
export const en: Record<WebdavSyncKey, string> = {
  sectionTitle: 'WebDAV sync',

  cardSummaryOff: 'WebDAV sync: off',
  cardSummaryOn: 'WebDAV sync: {url}',
  cardSummaryUnset: 'WebDAV sync: on, no address yet',

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
  partDefaults: 'Default model',
  partDefaultsHint: 'Which provider and model a new session starts on.',
  partPlugins: 'Installed plugins',
  partPluginsHint: 'Which plugins are installed and in what order they load. The packages themselves stay behind: each computer installs them.',
  partPatch: 'Other profile configuration',
  partPatchHint: 'MCP servers, permission presets, interface settings, insert blocks, and the rest.',
  partDirs: 'Extra directories',
  partDirsHint: 'Directories outside the profile, carried with the files inside them; the paths travel with this configuration, and a restore writes back into the same directory.',
  partSynced: 'In step',
  partOnlyHere: 'Changed here only',
  partOnlyThere: 'Changed on the server only',
  partBoth: 'Changed on both',

  lastCheck: 'Last check: {at}',
  neverChecked: 'Never checked yet',
  lastSync: 'Last sync: {at}',
  neverSynced: 'Never synced yet',

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

  confirmRestore: 'Take the server’s setup over this computer’s? What is here now is kept aside first, so it can be undone.',
  confirmUpload: 'Write this computer’s setup over the file on the server? The file there is kept aside first.',
  confirmOff: 'Stop syncing? The file on the server is not deleted.',
  yes: 'Yes',
  no: 'Cancel',

  previewEmpty: 'Both sides agree: a sync would change nothing.',
  previewTitle: 'A sync would do this',
  takeLocal: 'Push this computer’s copy',
  takeRemote: 'Bring in the server’s copy',
  takeNewerLocal: 'Both changed: keep this computer’s as the newer one',
  takeNewerRemote: 'Both changed: keep the server’s as the newer one',

  unavailable: 'Not available',
  partOff: 'Not synced',
  partOffHint: 'Off: this computer neither changes this part nor hands it to the others.',

  chooseDir: 'Choose directory',
  dirPlaceholder: 'Absolute path of the directory',
  dirRemove: 'Remove',
  dirProblem: 'Could not read the directory {path}: {message}',

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
  relayCopyFailed: 'Could not copy — select it and copy by hand',
}
