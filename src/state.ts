/**
 * The plugin's own files, all of them inside the profile's `.dsh-webdav-sync`:
 * the configuration (which holds the server password and the passphrase, so it is
 * written 0600), the sync state, and a cached copy of what the server held when
 * it was last read.
 *
 * The cache exists for one reason. A sync that finds the server unchanged still
 * has to merge, and merging is three-way: it needs the version of each part as
 * the server last held it. That is in the state, but the parts themselves are
 * needed to compute what a part *became* on the server. Keeping the last body
 * means a sync that only changed something here never downloads the file it is
 * about to write over.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  AUTO_CHOICES,
  AUTO_MANUAL,
  BACKUP_EXT,
  type Part,
  type StoredState,
  type SyncConfig,
} from './wire.js'
import { sum } from './crypto.js'
import { normaliseDirs } from './dirs.js'
import { isMissing, message, writeAtomic } from './store.js'
import type { ResolvedPaths } from './paths.js'

/** Name of the configuration file inside the state directory. */
export const CONFIG_NAME = 'sync.json'
/** Name of the sync state file. */
export const STATE_NAME = 'sync-state.json'
/** Name of the cached copy of the server's file. */
export const CACHE_NAME = `sync-server${BACKUP_EXT}`
/** Name of the directory holding copies the sync replaced. */
export const KEPT_DIR = 'sync'

/** Mode for anything holding a secret, and for the directory around it. */
const SECRET_MODE = 0o600
const DIR_MODE = 0o700

/** The configuration as first written, before anything is known. */
export function defaultConfig(): SyncConfig {
  return {
    url: '',
    user: '',
    password: '',
    passphrase: '',
    autoEvery: AUTO_MANUAL,
    models: true,
    defaults: true,
    plugins: true,
    patch: true,
    dirs: [],
    dirsEnabled: true,
    rememberPassword: true,
    headers: '',
  }
}

/** The configuration file's path. */
export function configFile(paths: ResolvedPaths): string {
  return join(paths.stateDir, CONFIG_NAME)
}

/** The sync state file's path. */
export function stateFile(paths: ResolvedPaths): string {
  return join(paths.stateDir, STATE_NAME)
}

/** The cached server copy's path. */
export function cacheFile(paths: ResolvedPaths): string {
  return join(paths.stateDir, CACHE_NAME)
}

/** The folder replaced copies are kept in. */
export function keptDir(paths: ResolvedPaths): string {
  return join(paths.stateDir, KEPT_DIR)
}

/**
 * Passwords that are in use but deliberately not written down.
 *
 * "Remember the password" off means it must not reach `sync.json`; it does not
 * mean it should stop working. Every route rebuilds its engine from that file,
 * so a password emptied there is one no request can carry and sync could not
 * sign in at all until the host restarted. It is held here for as long as the
 * host runs — keyed by state directory, so two profiles keep their own — and
 * handed back whenever the stored configuration is read.
 */
const held = new Map<string, string>()

/** Keep a password in memory only, for the profile it was given for. */
export function holdPassword(paths: ResolvedPaths, password: string): void {
  if (password === '') held.delete(paths.stateDir)
  else held.set(paths.stateDir, password)
}

/** Forget the in-memory password for a profile, on turning sync off or remembering again. */
export function releasePassword(paths: ResolvedPaths): void {
  held.delete(paths.stateDir)
}

/** The in-memory password for a profile, if one is being held. */
export function heldPassword(paths: ResolvedPaths): string | undefined {
  return held.get(paths.stateDir)
}

/**
 * Read the configuration, with anything unset filled in from the defaults, so a
 * file written by an older build never reads as a missing field.
 */
export async function loadConfig(paths: ResolvedPaths): Promise<{ config: SyncConfig; found: boolean }> {
  const raw = await readJson(configFile(paths))
  if (raw === undefined) return { config: defaultConfig(), found: false }
  return { config: normaliseConfig(raw), found: true }
}

/** Read the sync state; an empty one only when there is none. */
export async function loadState(paths: ResolvedPaths): Promise<StoredState> {
  const raw = await readJson(stateFile(paths))
  if (raw === undefined) return {}
  return raw as StoredState
}

/** Write the configuration, 0600 because it holds two secrets. */
export async function saveConfig(paths: ResolvedPaths, config: SyncConfig): Promise<void> {
  await writeAtomic(configFile(paths), `${JSON.stringify(config, null, 2)}\n`, SECRET_MODE)
}

/**
 * Write the configuration the way `rememberPassword` says it must be written.
 *
 * The configuration in hand always carries a usable password: one that was typed
 * this run and deliberately not remembered is put back into it, because a
 * password emptied out of the running half would leave sync unable to sign in
 * until the process restarted. Writing that object as it stands would therefore
 * put on disk exactly the password the user asked not to keep. Every writer of
 * the configuration goes through here, so that promise has one place to be kept —
 * see `docs/decisions/0019-session-password-not-remembered.md`.
 */
export async function persistConfig(paths: ResolvedPaths, config: SyncConfig): Promise<void> {
  if (config.rememberPassword) {
    await saveConfig(paths, config)
    releasePassword(paths)
    return
  }
  await saveConfig(paths, { ...config, password: '' })
  holdPassword(paths, config.password)
}

/** Write the state. It holds no secret, but it does name a folder, so it is 0600 too. */
export async function saveState(paths: ResolvedPaths, state: StoredState): Promise<void> {
  await writeAtomic(stateFile(paths), `${JSON.stringify(state, null, 2)}\n`, SECRET_MODE)
}

/** Write the state directory itself, 0700, before anything goes in it. */
export async function ensureStateDir(paths: ResolvedPaths): Promise<void> {
  await writeAtomicStateDir(paths)
}

async function writeAtomicStateDir(paths: ResolvedPaths): Promise<void> {
  const { mkdir, chmod } = await import('node:fs/promises')
  await mkdir(paths.stateDir, { recursive: true, mode: DIR_MODE })
  await chmod(paths.stateDir, DIR_MODE).catch(() => undefined)
}

/** Keep the body just read or written, so the next sync can merge without it. */
export async function remember(paths: ResolvedPaths, data: Uint8Array): Promise<void> {
  await writeAtomic(cacheFile(paths), data, SECRET_MODE)
}

/**
 * The cached body, but only when it hashes to what is expected. A cache that
 * does not match is not the version the state describes, so it is not one the
 * merge may stand in for.
 */
export async function cached(paths: ResolvedPaths, want: string | undefined): Promise<Uint8Array | undefined> {
  if (want === undefined || want === '') return undefined
  let data: Buffer
  try {
    data = await readFile(cacheFile(paths))
  } catch (cause) {
    if (isMissing(cause)) return undefined
    throw cause
  }
  return sum(data) === want ? new Uint8Array(data) : undefined
}

/**
 * Identifies the thing a state describes: one server, one account, one
 * passphrase. A change to any of them resets the state, because the hashes in it
 * are about a file that is no longer the one being synced.
 *
 * The password is deliberately not here: it opens the same file rather than
 * pointing at a different one, and dropping a usable baseline whenever someone
 * rotates a password would make this computer adopt the server wholesale on the
 * next sync. See `docs/decisions/0026-password-not-in-state-key.md`.
 */
export function stateKey(config: SyncConfig): string {
  return createHash('sha256')
    .update([config.url.trim().replace(/\/+$/, ''), '\u0000', config.user, '\u0000', config.passphrase].join(''))
    .digest('hex')
}

/**
 * Whether two configurations point at the same account. A password is only ever
 * reused for the server and user it was given for: keeping one across an address
 * change is how a password for one service gets sent to another.
 */
export function sameAccount(a: SyncConfig, b: SyncConfig): boolean {
  return normaliseUrl(a.url) === normaliseUrl(b.url) && a.user.trim() === b.user.trim()
}

/** An address with its trailing slashes gone, for comparing two of them. */
export function normaliseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/**
 * Whether the configuration is complete enough to reach a server. The
 * passphrase is trimmed for the same reason `seal` refuses a blank one: a
 * passphrase of spaces would seal nothing, so a timer must not treat it as
 * ready and start syncs that can only fail.
 */
export function usable(config: SyncConfig): boolean {
  return normaliseUrl(config.url) !== '' && config.passphrase.trim() !== ''
}

/** Whether a part travels with this configuration. */
export function syncsPart(config: SyncConfig, part: Part): boolean {
  switch (part) {
    case 'models':
      return config.models
    case 'defaults':
      return config.defaults
    case 'plugins':
      return config.plugins
    case 'patch':
      return config.patch
    // The extra directories carry a switch of their own, like the four parts above:
    // the list of paths says *which* directories, the switch says whether this
    // computer carries them at all. Off keeps the list — the paths are not
    // forgotten — and changes nothing anywhere else: the part is carried through
    // untouched, so a machine that stops carrying them never deletes them for the
    // others.
    case 'dirs':
      return config.dirsEnabled
  }
}

/** Fill in defaults and coerce the several fields that come from a browser. */
export function normaliseConfig(raw: Record<string, unknown>): SyncConfig {
  const base = defaultConfig()
  const text = (key: keyof SyncConfig): string => {
    const value = raw[key]
    return typeof value === 'string' ? value : (base[key] as string)
  }
  const flag = (key: keyof SyncConfig): boolean => {
    const value = raw[key]
    return typeof value === 'boolean' ? value : (base[key] as boolean)
  }
  const auto = raw.autoEvery
  const autoEvery =
    typeof auto === 'number' && Number.isInteger(auto) && AUTO_CHOICES.includes(auto) ? auto : AUTO_MANUAL
  return {
    url: text('url'),
    user: text('user'),
    password: text('password'),
    passphrase: text('passphrase'),
    autoEvery,
    models: flag('models'),
    defaults: flag('defaults'),
    plugins: flag('plugins'),
    patch: flag('patch'),
    dirs: Array.isArray(raw.dirs) ? normaliseDirs(raw.dirs) : base.dirs,
    dirsEnabled: flag('dirsEnabled'),
    rememberPassword: flag('rememberPassword'),
    headers: text('headers'),
  }
}

/**
 * Read a JSON object out of one of the plugin's own files.
 *
 * Only a file that is *not there* reads as nothing. A file that is there but
 * unreadable is a different thing and used to be treated as the same one: the
 * configuration fell back to defaults, so the address and passphrase silently
 * became empty, and the state read as a fresh one, so every part looked like a
 * part the server had changed and the server's copy came over the top of this
 * computer's work. Both files here are written whole by `writeAtomic`, so one
 * that cannot be parsed was damaged from outside — worth saying so, with its
 * name, rather than pretending it was never written.
 */
async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (cause) {
    if (isMissing(cause)) return undefined
    throw cause
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw new Error(`${file} 不是可读的 JSON：${message(cause)}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${file} 里不是 JSON 对象`)
  }
  return value as Record<string, unknown>
}
