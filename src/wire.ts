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
/** POST: what one sync would do, without writing anything anywhere. */
export const ROUTE_PREVIEW = `${ROUTE_PREFIX}/preview`
/** POST: put back the copies a restore replaced. */
export const ROUTE_UNDO = `${ROUTE_PREFIX}/undo`
/** POST: write one passphrase-sealed backup file into a folder the person picked. */
export const ROUTE_EXPORT = `${ROUTE_PREFIX}/export`
/** POST: open a picked backup file and put what it holds on this computer. */
export const ROUTE_IMPORT = `${ROUTE_PREFIX}/import`

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
export const REMOTE_FILE = 'dsh-profile.prop'
/** Extension the sealed envelope is written with. */
export const BACKUP_EXT = '.prop'
/**
 * The name {@link REMOTE_FILE} had before the suffix changed. Only ever read:
 * a folder filled by an earlier version still holds its backup under this name,
 * and finding it by the new one alone would read as "the server has nothing of
 * ours" — which makes this computer push its own setup up, over whatever the
 * other computer left there. See `docs/decisions/0035-backup-suffix-prop.md`.
 */
export const LEGACY_REMOTE_FILE = 'dsh-profile.dshsync'

// ---------------------------------------------------------------------------
// The sync parts
// ---------------------------------------------------------------------------

/**
 * The parts of a DSH setup that travel, in the one order this plugin uses for
 * them everywhere: the rows of 「同步内容」, the merge, and every list it reports
 * back (`PreviewResult.changes`, a notice's 「哪几份」, an export's parts). Each is
 * hashed on its own, so a change to one never drags the others along behind it,
 * which is why the order carries no meaning beyond reading: `keys` sits second
 * because the keys belong to the providers in the row above them, and an owner
 * reading the card looks for the two together. See
 * `docs/decisions/0067-part-order-and-backup-icons.md`.
 *
 * `dirs` is the one part that does not come from a profile file: it is the whole
 * set of extra directories the user named, each carried with its files, so a
 * second computer gets both the path and what is under it. Its empty value is a
 * real value (`{ dirs: [] }`), not an absent part, because "the list is now
 * empty" is a change that has to travel like any other.
 *
 * `keys` is the one part whose content is a secret, and the one part that lives
 * outside the profile: the API keys this computer's credential store holds for its
 * providers. It is on by default, because a setup that travels without its keys
 * arrives with every provider unauthenticated, and it can be switched off on its
 * own; see {@link KeysPart}.
 *
 * The default model is deliberately *not* a part: which model a new session starts
 * on is changed several times a day, and every change would push a file for
 * something a person sets on each computer anyway. Its row stays out of `patch`
 * too, like this plugin's own row. See `docs/decisions/0056-drop-default-model-part.md`.
 */
export const PARTS = ['models', 'keys', 'plugins', 'patch', 'dirs'] as const
export type Part = (typeof PARTS)[number]

/**
 * Most extra directories one configuration may name.
 *
 * Each one is walked on every card open and carried whole on every push, so this
 * is a bound on the work a configuration can quietly ask for — and the card needs
 * to know it to stop offering "add" once it is reached.
 */
export const DIRS_MAX = 5

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

/** The `models` part: the model catalog exactly as the profile patch holds it. */
export interface ModelsPart {
  /** The whole `llm-pi-ai` entry config, so fields beyond `providers` travel too. */
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

/** One file of an extra directory, carried whole. */
export interface DirFileSpec {
  /** Path relative to the directory it belongs to, `/` between segments. */
  path: string
  /** The file's bytes, base64. Text files travel as their UTF-8 bytes like any other. */
  data: string
}

/** One extra directory: an absolute path on the computer that synced it, and its files. */
export interface DirSpec {
  /**
   * The directory's own path, exactly as the computer that synced it has it. The
   * path travels so a restore writes back into the same directory, which is what
   * naming a directory here means.
   */
  path: string
  /** Its files, ordered by `path`, with the skip list already applied. */
  files: DirFileSpec[]
}

/**
 * The `dirs` part: directories outside the profile that travel with it.
 *
 * This is the one part a machine cannot be asked about cheaply — reading it means
 * walking every directory the user named — so it is also the one part whose read
 * can fail in a way that must not look like "the directory is empty". A directory
 * that cannot be read is reported to the card and left exactly as the server has
 * it for that sync; see {@link StatusResult.dirProblems}.
 */
export interface DirsPart {
  dirs: DirSpec[]
}

/**
 * A credential this computer could not read or write, and why not.
 *
 * A store that cannot be read must not look like a store with nothing in it: an
 * empty read would say "this computer has no keys", which is a real answer a sync
 * acts on. This is how the two are told apart, the same way {@link DirProblem}
 * keeps an unreadable directory from looking like an empty one.
 */
export interface KeyProblem {
  /** The reference name, as the profile asks for it; '' when the store itself failed. */
  ref: string
  /** What went wrong, in a sentence the card can show. */
  message: string
}

/** A configured directory this computer could not read, and why not. */
export interface DirProblem {
  /** The configured path, as it is stored. */
  path: string
  /** What went wrong, in a sentence the card can show. */
  message: string
  /**
   * True when the directory simply is not here.
   *
   * The difference from every other problem is not how the card shows it but what a
   * write is allowed to do: a directory this computer cannot *read* is left alone, so
   * a sync never writes blind over what it could not see — while one that is merely
   * absent is exactly where a restore has to create it. Marking it keeps the two
   * apart after the read has already happened.
   */
  missing?: boolean
}

/**
 * The `keys` part: the API keys this computer holds for its providers.
 *
 * The profile names a credential instead of holding it — `apiKeyEnv: OFOX_API_KEY`
 * on a provider route, `secretEnv` on a GitHub webhook — and the value behind that
 * name lives in this computer's credential store (`$DSH_HOME/.credentials.yaml`).
 * That is why a setup synced without this part arrives complete and still cannot
 * talk to a single provider: it carries the names, and the names resolve to
 * nothing here.
 *
 * A name is the whole address of a secret, so this part is a map and not a list:
 * applying it puts each value back under the name the profile already asks for.
 * Nothing here is ever deleted — a key removed on one computer stays on the others,
 * because a credential a person stored by hand is not this plugin's to throw away.
 * See `docs/decisions/0054-sync-api-keys.md`.
 */
export interface KeysPart {
  /**
   * Secret values by the reference name that resolves them, exactly as the
   * credential store holds them (`apiKeyEnv`/`secretEnv` values, verbatim).
   *
   * Only names this computer actually has a stored value for appear; a name that
   * falls through to the environment is left out, since the environment is the
   * other computer's own business.
   */
  refs: Record<string, string>
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
  plugins?: PluginsPart
  patch?: PatchPart
  dirs?: DirsPart
  keys?: KeysPart
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
  plugins?: string
  patch?: string
  dirs?: string
  keys?: string
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
  /** True once keys have a trustworthy local comparison baseline. */
  keysBaseline?: boolean | undefined
  /**
   * Last attempt that actually moved something, ISO-8601: a push, a part taken
   * from the server, or a restore. Absent until one has. This is the difference
   * from {@link StoredState.last}, where every attempt lands whether or not the
   * two sides had anything new to say to each other.
   */
  moved?: string | undefined
  /** Last failure's message, empty when the last attempt succeeded. */
  error?: string | undefined
  /**
   * The configuration `error` was recorded against. A failure that changes the
   * state key — a wrong passphrase is one — would otherwise leave no trace,
   * because the stored key is the baseline's and can never match it.
   */
  errorKey?: string | undefined
  notice?: Notice | undefined
  /**
   * Signatures of the conditional prompts the person chose to hide, per kind.
   * A prompt whose content changes — a different plugin name, a different
   * directory problem — gets a different signature and shows up again; the
   * dismissal only ever silences exactly what was on screen.
   */
  dismissed?: Dismissed | undefined
}

/**
 * Content signatures of the prompts hidden by hand, one field per kind of
 * prompt the host recomputes on every status read. Each holds the stable
 * serialization of the payload the person dismissed.
 */
export interface Dismissed {
  /** Signature of the {@link StatusResult.pendingNames} list hidden. */
  pendingInstall?: string | undefined
  /** Signature of the {@link StatusResult.dirProblems} list hidden. */
  dirProblems?: string | undefined
  /** Signature of the {@link StatusResult.keysProblems} list hidden. */
  keyProblems?: string | undefined
}

/**
 * Which kind of prompt a {@link ROUTE_DISMISS} call hides. Every kind the
 * host recomputes needs its own signature slot; a signature of `undefined`
 * clears the slot (used for the plain notice dismiss).
 */
export type DismissTarget = 'pending-install' | 'dir-problems' | 'key-problems'

/** POST {@link ROUTE_DISMISS} body. */
export interface DismissBody {
  /** Which prompt to hide; absent (or `notice`) dismisses the sync notice. */
  target?: DismissTarget
  /**
   * Stable serialization of the payload on screen when the person dismissed
   * it. Required for every target; the stored signature must match it to
   * keep the prompt hidden.
   */
  signature?: string
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
  /** Whether the installed-plugin list travels. */
  plugins: boolean
  /** Whether the remaining profile-patch rows travel. */
  patch: boolean
  /**
   * Whether this computer's stored API keys travel.
   *
   * On by default: a provider route names its credential, so a setup synced
   * without the keys arrives with every provider unauthenticated. Turning it off
   * keeps this computer's keys off the server entirely — nothing is deleted
   * anywhere, and the server's copy of the part is carried through untouched,
   * exactly as for the three parts above.
   */
  keys: boolean
  /**
   * Absolute paths of the extra directories that travel with the setup, in the
   * order the user added them. The list itself is the `dirs` part, so what is
   * named here is exactly what is synced: adding one starts carrying it, removing
   * one stops. Never a relative path — see {@link DirSpec}.
   */
  dirs: string[]
  /**
   * Whether the extra directories travel with this setup.
   *
   * Off is the resting state: a configuration that has not said otherwise carries
   * no directory. The list above is kept either way: switching this off says "this
   * computer does not carry them", not "forget them". Nothing is deleted anywhere
   * by turning it off — the server's copy of the part is carried through
   * untouched, exactly as for the other parts.
   */
  dirsEnabled: boolean
  /** Whether the plugin's own address, user and password are kept for next time. */
  rememberPassword: boolean
  /**
   * Extra request headers, one `Name: value` per line, sent with every request
   * to the server. Transport detail: a secret here stays out of the state key
   * and out of error messages.
   */
  headers: string
  /**
   * Whether this computer forwards for other WebDAV clients on it.
   *
   * The forwarder is not a second configuration: it goes to the address, account
   * and headers above, and only adds a door a local client can come in by. Off is
   * the resting state, and nothing about the sync reads this.
   */
  relayEnabled: boolean
  /**
   * The loopback port the forwarder listens on.
   *
   * Chosen once and kept: a client holds the whole address as the identity of the
   * server it syncs with, so a changed port is a different server to it — it would
   * start its join from scratch.
   */
  relayPort: number
  /**
   * The account a client signs in with at the forwarder, minted the first time
   * forwarding is switched on and then kept: it is written into the client's own
   * configuration, so a new one would lock that client out.
   */
  relayUser: string
  /** The password half of {@link relayUser}. Shown to the user, since it exists to be copied. */
  relayPassword: string
}

/** The configuration as the card sees it: never a secret, only whether one is set. */
export interface ConfigView {
  url: string
  user: string
  passwordSet: boolean
  passphraseSet: boolean
  autoEvery: number
  models: boolean
  plugins: boolean
  patch: boolean
  /** Whether this computer's stored API keys travel. */
  keys: boolean
  /** The extra directories that travel, as stored. Not a secret. */
  dirs: string[]
  /** Whether the extra directories travel with the current configuration. */
  dirsEnabled: boolean
  rememberPassword: boolean
  /** Extra request headers, one `Name: value` per line. Not a secret: travels to the card. */
  headers: string
  /** Whether the forwarder is switched on for this configuration. */
  relayEnabled: boolean
  /**
   * The loopback port it listens on, so the card's draft holds the real one and
   * shows an address that matches it. Not a secret, and not synced.
   */
  relayPort: number
}

/** Where the plugin's files live, as the card shows them. */
export interface PathsView {
  profileDir: string
  stateDir: string
  patchFile: string
  /**
   * The home patch, present only when DSH reads this profile's model catalog from
   * there instead of from {@link patchFile} — see
   * `docs/decisions/0071-sync-the-catalog-where-it-takes-effect.md`.
   */
  modelsFile?: string
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
  /**
   * ISO-8601 of the last attempt that moved something — a push, a part taken from
   * the server, a restore, an upload. Absent when none has, and equal to `last`
   * after a forced or first sync. The gap between the two is a sync that ran and
   * found nothing to do.
   */
  moved?: string
  /** Last failure's message, empty when the last attempt succeeded. */
  error: string
  notice?: Notice
  /** What changed since the last sync, per part. */
  parts: PartView[]
  /**
   * The forwarder for other clients on this computer, present whenever the host
   * has one. It rides the status because it is a switch on this same
   * configuration: the card reads and writes it with everything else, and a
   * second route would only be a second way to say the same thing.
   */
  relay?: RelayView
  /**
   * Extra directories the configuration names that could not be read here, with
   * the reason. Present exactly when there is at least one: a directory that
   * cannot be read is left untouched by the sync rather than read as empty, and
   * this is how the card is able to say so.
   */
  dirProblems?: DirProblem[]
  /**
   * Credentials the configuration names that could not be read here, with the
   * reason. Present exactly when there is at least one, for the same reason as
   * {@link StatusResult.dirProblems}: a store that cannot be read is left as the
   * server has it for this sync rather than read as empty.
   */
  keysProblems?: KeyProblem[]
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
  plugins?: boolean
  patch?: boolean
  /** Whether this computer's stored API keys travel. */
  keys?: boolean
  /** The whole list of extra directories, replacing the stored one. */
  dirs?: string[]
  /** Whether the extra directories travel with this setup. */
  dirsEnabled?: boolean
  rememberPassword?: boolean
  headers?: string
  /** Whether the forwarder for other clients on this computer is switched on. */
  relayEnabled?: boolean
  /**
   * The loopback port it listens on.
   *
   * It is asked for rather than fixed because a port can already be taken, and a
   * forwarder that could not be moved off a taken one would simply be unusable on
   * that computer. Changing it is the same edit as turning the switch on: the
   * card shows the address to paste, so the new one is in front of the user as
   * they do it. Nothing else is affected — `sync.json` is this computer's own
   * file and never travels, so another computer keeps its own port.
   */
  relayPort?: number
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
  /**
   * Keys the merge brought here that this computer's credential store would not
   * take, with the reason. Present exactly when there is at least one: a key that
   * could not be stored leaves that provider unauthenticated, and a sync that
   * reported success would hide it.
   */
  keysProblems?: KeyProblem[]
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

/** POST {@link ROUTE_EXPORT} body. */
export interface ExportBody {
  /**
   * The passphrase this file is sealed with.
   *
   * It is asked for on every export rather than taken from the configuration:
   * the file leaves this computer, and the sync passphrase is the one thing that
   * also opens the copy on the server. Typing a second one for the file means a
   * file that leaks opens nothing else.
   */
  passphrase?: string
  /**
   * Where to write it: a folder, or a full path ending in `.prop`.
   *
   * Blank means the home folder. A folder is asked for rather than fixed because
   * the point of the file is to be carried somewhere — a removable disk, a shared
   * folder — and only the person knows which one.
   */
  dir?: string
}

/** POST {@link ROUTE_EXPORT} result. */
export interface ExportResult {
  /** Absolute path of the file that was written. */
  file: string
  /** How many bytes it is. */
  size: number
  /** Which parts of the setup the file carries. */
  parts: Part[]
}

/** POST {@link ROUTE_IMPORT} body. */
export interface ImportBody {
  /** The passphrase the file was sealed with. */
  passphrase?: string
  /**
   * The file's own text, as the browser read it.
   *
   * It travels as text rather than as a path because the browser half cannot see
   * the filesystem: a picked file is a `File` whose bytes only that half holds.
   * The sealed backup is indented JSON, so its text is its bytes.
   */
  text?: string
}

/** POST {@link ROUTE_IMPORT} result. */
export interface ImportResult {
  /** Parts the file put on this computer. */
  here: Part[]
  /** Parts the file carried that this computer already held unchanged. */
  same: Part[]
  /** Folder the replaced copies were kept in, when any were. */
  saved?: string
  /** The profile has to be reloaded for the applied configuration to take effect. */
  reloadNeeded: boolean
  /** The profile now declares plugins that are not installed; run the install action. */
  pendingInstall: boolean
  /** Which plugins those are, present exactly when {@link pendingInstall} is true. */
  pendingNames?: string[]
  /** Keys the file brought that this computer's credential store would not take. */
  keysProblems?: KeyProblem[]
  /** When the exporting computer wrote the file, ISO-8601. */
  created: string
}

/** Which of a part's two sides a preview call would take. */
export interface PreviewChange {
  part: Part
  /** `local` takes this computer's copy (it is newer or the server has none). */
  take: 'local' | 'remote' | 'newer-local' | 'newer-remote'
}

/** POST {@link ROUTE_PREVIEW}. */
export interface PreviewResult {
  /** What the merge would do, part by part. Empty when nothing changed anywhere. */
  changes: PreviewChange[]
}

// ---------------------------------------------------------------------------
// The local forwarder — a switch on the configuration above, not a second one
// ---------------------------------------------------------------------------

/** Loopback port the forwarder listens on when nothing else was asked for. */
export const RELAY_DEFAULT_PORT = 3426

/** Bytes of randomness in the generated account's name; hex, so it is easy to type. */
export const RELAY_USER_BYTES = 2
/** Bytes of randomness in its password; hex, so it is easy to copy. */
export const RELAY_PASSWORD_BYTES = 16

/**
 * The forwarder as the card shows it.
 *
 * It carries the account in the clear, unlike everything else the card is told:
 * the whole reason the account exists is to be written into another program, and
 * a secret the user cannot read is one they cannot copy. It lives in the plugin's
 * own `sync.json`, which is the same file the WebDAV password is in.
 */
export interface RelayView {
  /** Whether anything listens. */
  enabled: boolean
  /** The loopback port it listens on. */
  port: number
  /** The address to give a client, or '' while there is nothing to hand out. */
  url: string
  /** The account a client signs in with. */
  user: string
  /** Its password. */
  password: string
  /** Whether it is listening right now. */
  listening: boolean
  /** Why it is not, empty when all is well. */
  error: string
}

/**
 * The address a client is given: loopback, the port, and the server's own path.
 *
 * The path is carried over so that the rest of the address means the same thing
 * to the client as the real server's address did — a client that joins its own
 * paths onto the host alone, and one that keeps the base path it was given, both
 * end up asking for the same place. Pure form: the same port and target always
 * give the same address.
 */
export function relayUrl(port: number, basePath: string): string {
  return `http://127.0.0.1:${port}${basePath}`
}

/**
 * The path part of a WebDAV address, which the forwarded address carries over.
 *
 * `https://host/dav/` gives `/dav`; an address with no path, one that cannot be
 * read at all, or one that is not http(s) gives ''. Both halves work out the
 * forwarded address from this, so the line the card shows is the address the host
 * would hand out for the same draft rather than a second opinion about it.
 */
export function relayBasePath(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    return parsed.pathname.replace(/\/+$/, '')
  } catch {
    return ''
  }
}
