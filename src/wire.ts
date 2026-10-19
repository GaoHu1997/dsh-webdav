/**
 * dsh-webdav-sync wire contract: the zero-runtime-dependency module both the
 * Host half and the browser half import. Nothing here touches node:fs, node:crypto
 * or React, so the browser bundle can pull it in without widening its surface.
 *
 * The shapes below are the plugin's own protocol: the sealed backup that travels
 * to the WebDAV server, the local sync state that never leaves this computer, and
 * the HTTP envelopes the settings card talks to.
 */

/** Every route this plugin owns lives under this prefix. */
export const ROUTE_PREFIX = '/plugin/webdav-sync'

/** GET: configuration (without secrets), state, notice, and what installs pend. */
export const ROUTE_STATUS = `${ROUTE_PREFIX}/status`
/** POST: save the sync configuration. */
export const ROUTE_CONFIG = `${ROUTE_PREFIX}/config`
/** POST: reach the server with the stored configuration and report what happened. */
export const ROUTE_CHECK = `${ROUTE_PREFIX}/check`
/** POST: run one merge. `{ force }` runs it even when nothing looks changed. */
export const ROUTE_SYNC = `${ROUTE_PREFIX}/sync`
/** POST: make this computer's setup the server's. */
export const ROUTE_RESTORE = `${ROUTE_PREFIX}/restore`
/** POST: write over a file on the server that is not a backup of ours. */
export const ROUTE_UPLOAD = `${ROUTE_PREFIX}/upload`
/** POST: clear the sync notice. */
export const ROUTE_DISMISS = `${ROUTE_PREFIX}/dismiss`
/** POST: forget the configuration and stop syncing. */
export const ROUTE_OFF = `${ROUTE_PREFIX}/off`
/** POST: install the profile's declared plugins with the bundled pnpm. */
export const ROUTE_INSTALL = `${ROUTE_PREFIX}/install`
/** GET: what one sync would do, without writing anything anywhere. */
export const ROUTE_PREVIEW = `${ROUTE_PREFIX}/preview`
/** POST: put back the copies a restore replaced. */
export const ROUTE_UNDO = `${ROUTE_PREFIX}/undo`

/** Error envelope shared by every route. */
export interface RouteError {
  error: string
}

// ---------------------------------------------------------------------------
// Remote folder layout
// ---------------------------------------------------------------------------

/**
 * Folder made inside the WebDAV address, and the one file kept in it. One sealed
 * file rather than a mirror of the profile: the merge is three-way per part, so
 * the server only ever holds whole versions of the whole setup.
 */
export const REMOTE_FOLDER = 'dsh-webdav'
/** The single sealed file this plugin owns on the server. */
export const REMOTE_FILE = 'dsh-profile.dshsync'
/** Extension the sealed envelope is written with. */
export const BACKUP_EXT = '.dshsync'

// ---------------------------------------------------------------------------
// The sync parts
// ---------------------------------------------------------------------------

/**
 * The parts of a DSH setup that travel, in merge order. Each is hashed on its
 * own, so a change to one never drags the others along behind it.
 */
export const PARTS = ['models', 'defaults', 'plugins', 'patch'] as const
export type Part = (typeof PARTS)[number]

/** Human copy for each part, used by the card and by notices. */
export const PART_LABELS: Record<Part, { zh: string; en: string }> = {
  models: { zh: '模型供应商与模型', en: 'Model providers and models' },
  defaults: { zh: '默认模型', en: 'Default model' },
  plugins: { zh: '已安装插件', en: 'Installed plugins' },
  patch: { zh: '其余 profile 配置', en: 'Other profile configuration' },
}

/** One model as the provider catalog declares it. Fields are open: the row is carried verbatim. */
export interface ModelSpec {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: string[]
  reasoning?: string
  reasoningEfforts?: Record<string, string | null>
  defaultEffort?: string | null
  compat?: Record<string, unknown>
  [key: string]: unknown
}

/** One provider entry under `llm-pi-ai.config.providers`. */
export interface ProviderSpec {
  displayName?: string
  apiKeyEnv?: string
  api?: string
  baseURL?: string
  models?: ModelSpec[]
  [key: string]: unknown
}

/** The `models` part: the model catalog exactly as the profile patch holds it. */
export interface ModelsPart {
  /** The whole `llm-pi-ai` entry config, so fields beyond `providers` travel too. */
  config: Record<string, unknown>
}

/** The `defaults` part: which provider/model new sessions start on. */
export interface DefaultsPart {
  /** The whole `agent-default-model` entry config. */
  config: Record<string, unknown>
}

/** One other top-level row of the profile patch, carried by the `patch` part. */
export interface PatchEntry {
  /** `id` of an id-targeted row, or `insert` for an insert block. */
  id: string
  /** For an insert block: the rows it inserts, verbatim. */
  insert?: unknown[]
  /** For an id-targeted row: its `name`. */
  name?: string
  /** For an id-targeted row: its `config`. */
  config?: unknown
  /** Any other keys of the row, carried verbatim. */
  [key: string]: unknown
}

/** The `patch` part: every profile-patch row that is not a model row. */
export interface PatchPart {
  entries: PatchEntry[]
}

/** The `plugins` part: what the profile's package.json declares as installed. */
export interface PluginsPart {
  /** `dependencies` of the profile package.json, verbatim. */
  dependencies: Record<string, string>
  /** `dsh.profile.bundles`, verbatim and in order. */
  bundles: string[]
}

/** Everything one sealed backup carries. Field names are the wire format. */
export interface Bundle {
  format: 'dsh-webdav-sync-backup'
  version: 1
  /** When the writing computer sealed it, ISO-8601 UTC. The merge's tie-breaker. */
  created: string
  /** Which app sealed it, for a file several tools might share a folder with. */
  app: string
  models?: ModelsPart
  defaults?: DefaultsPart
  plugins?: PluginsPart
  patch?: PatchPart
}

/** The format word in the envelope; anything else on the server is not ours. */
export const BUNDLE_FORMAT = 'dsh-webdav-sync-backup'
/** The bundle structure version this build writes and reads. */
export const BUNDLE_VERSION = 1
/** Value written to `Bundle.app`. */
export const BUNDLE_APP = 'dsh-webdav-sync'

// ---------------------------------------------------------------------------
// Local sync state — never sent anywhere
// ---------------------------------------------------------------------------

/** The server's own name for one version of the file. */
export interface ServerVersion {
  /** ETag, when the server gives one. */
  etag?: string
  /** Last-Modified, used only when there is no ETag that can be matched again. */
  modified?: string
}

/** Which parts the last sync moved, and where the replaced copies were kept. */
export interface Notice {
  at: string
  /** Parts this computer's copy replaced with the server's. */
  here: Part[]
  /** Parts the server's copy replaced with this computer's. */
  there: Part[]
  /** Folder holding the copies that were replaced. */
  saved?: string
  /** True when a Restore, not a sync, produced this notice. */
  restored?: boolean
}

/** One side of the last completed sync, per part. */
export interface PartHashes {
  models?: string
  defaults?: string
  plugins?: string
  patch?: string
}

/**
 * The variable half of the state: everything a completed sync records.
 *
 * Each optional field also admits an explicit `undefined`, because a sync clears
 * them by assignment — and with `exactOptionalPropertyTypes` a field that may be
 * absent is not the same as one that may be set to nothing.
 */
export interface SyncRecord {
  /** Server version read at the last successful sync. */
  server?: ServerVersion | undefined
  /** SHA-256 of the sealed bytes last seen on the server. */
  sum?: string | undefined
  /** Part hashes as this computer left them after the last sync. */
  local?: PartHashes | undefined
  /** Part hashes as the server left them after the last sync. */
  remote?: PartHashes | undefined
  /** Set when a write happened without the server checking the version. */
  blind?:
    | {
        sum?: string | undefined
        local?: PartHashes | undefined
        remote?: PartHashes | undefined
      }
    | undefined
  /** Sealed copy kept before a Restore, so Undo can put it back. */
  undo?: string | undefined
}

/** What is on disk under the plugin's state directory. */
export interface StoredState extends SyncRecord {
  /** Identifies the server+account+passphrase this state describes. */
  key?: string | undefined
  /** Last sync attempt, ISO-8601. */
  last?: string | undefined
  /** Last failure's message, empty when the last attempt succeeded. */
  error?: string | undefined
  /**
   * The configuration `error` was recorded against. A failure that changes the
   * state key — a wrong passphrase is one — would otherwise leave no trace,
   * because the stored key is the baseline's and can never match it.
   */
  errorKey?: string | undefined
  notice?: Notice | undefined
}

/** How often the gateway syncs on its own. `-1` is "only when asked". */
export const AUTO_MANUAL = -1
/** The intervals the card offers, in minutes. */
export const AUTO_CHOICES: readonly number[] = [AUTO_MANUAL, 3, 15, 30, 60]

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The stored sync configuration. Secrets live here and never in the profile patch. */
export interface SyncConfig {
  url: string
  user: string
  password: string
  passphrase: string
  /** How often the gateway syncs by itself, in minutes, or {@link AUTO_MANUAL}. */
  autoEvery: number
  /** Whether the model catalog travels. */
  models: boolean
  /** Whether the default-model row travels. */
  defaults: boolean
  /** Whether the installed-plugin list travels. */
  plugins: boolean
  /** Whether the remaining profile-patch rows travel. */
  patch: boolean
  /** Whether the plugin's own address, user and password are kept for next time. */
  rememberPassword: boolean
}

/** The configuration as the card sees it: never a secret, only whether one is set. */
export interface ConfigView {
  url: string
  user: string
  passwordSet: boolean
  passphraseSet: boolean
  autoEvery: number
  models: boolean
  defaults: boolean
  plugins: boolean
  patch: boolean
  rememberPassword: boolean
}

/** Where the plugin's files live, as the card shows them. */
export interface PathsView {
  profileDir: string
  stateDir: string
  patchFile: string
  packageFile: string
}

/** One part's standing, as the card shows it. */
export interface PartView {
  part: Part
  /** What this computer holds now, `null` when the part is empty here. */
  local: string | null
  /** What the server held at the last sync, `null` when it held none. */
  remote: string | null
  /** Whether the part changed here since the last sync. */
  localChanged: boolean
  /** Whether the part changed on the server since the last sync. */
  remoteChanged: boolean
  /** The part travels with the current configuration. */
  synced: boolean
}

/** GET {@link ROUTE_STATUS}. */
export interface StatusResult {
  /** False until a usable configuration is stored. */
  configured: boolean
  config: ConfigView
  paths: PathsView
  /** ISO-8601 of the last attempt, absent when none was made. */
  last?: string
  /** Last failure's message, empty when the last attempt succeeded. */
  error: string
  notice?: Notice
  /** What changed since the last sync, per part. */
  parts: PartView[]
  /** The profile declares plugins the installed tree does not have yet. */
  pendingInstall: boolean
  /** Which plugins those are, present exactly when {@link pendingInstall} is true. */
  pendingNames?: string[]
  /** Whether a Restore can be undone. */
  undoable: boolean
}

/** POST {@link ROUTE_CONFIG} body. A blank secret leaves the stored one alone. */
export interface ConfigureBody {
  url?: string
  user?: string
  password?: string
  passphrase?: string
  autoEvery?: number
  models?: boolean
  defaults?: boolean
  plugins?: boolean
  patch?: boolean
  rememberPassword?: boolean
}

/** POST {@link ROUTE_SYNC} body. */
export interface SyncBody {
  /** Sync even when nothing looks changed on either side. */
  force?: boolean
}

/** What one sync, restore, upload or preview did. */
export interface SyncResult {
  /** Parts this computer's copy replaced with the server's. */
  here: Part[]
  /** Parts the server's copy replaced with this computer's. */
  there: Part[]
  /** Folder the replaced copies were kept in, when any were. */
  saved?: string
  /** True when this call wrote a new file to the server. */
  pushed: boolean
  /** The profile now declares plugins that are not installed; run the install action. */
  pendingInstall: boolean
  /** Which plugins those are, present exactly when {@link pendingInstall} is true. */
  pendingNames?: string[]
  /** The profile has to be reloaded for the applied configuration to take effect. */
  reloadNeeded: boolean
}

/** POST {@link ROUTE_CHECK} result. */
export interface CheckResult {
  /** The server answered and the account may read and write the folder. */
  ok: boolean
  /** What the server answered, for the card to show either way. */
  message: string
  /** Whether a file of ours is already on the server. */
  hasBackup: boolean
  /** Size of that file in bytes, when it is ours. */
  size?: number
  /** When it was written, ISO-8601, when the server says. */
  created?: string
}

/** POST {@link ROUTE_INSTALL} result. */
export interface InstallResult {
  ok: boolean
  /** The install command's own output tail, for the card to show. */
  output: string
}

/** Envelope for any route whose body carries only a message. */
export interface MessageResult {
  message: string
}

/** Which of a part's two sides a preview call would take. */
export interface PreviewChange {
  part: Part
  /** `local` takes this computer's copy (it is newer or the server has none). */
  take: 'local' | 'remote' | 'newer-local' | 'newer-remote'
}

/** GET {@link ROUTE_PREVIEW}. */
export interface PreviewResult {
  /** What the merge would do, part by part. Empty when nothing changed anywhere. */
  changes: PreviewChange[]
}
