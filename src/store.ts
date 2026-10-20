/**
 * Reading and writing a DSH profile.
 *
 * Two files matter. `cordis.patch.yml` is the profile's own patch layer — a
 * top-level YAML array of loader rows, each either an id-targeted override or an
 * `insert:` block that pushes new rows in. The model catalog is one of those rows
 * (`llm-pi-ai`), the default model is another (`agent-default-model`), and
 * everything else — MCP servers, permission presets, UI settings, inserts — is
 * the rest of them. `package.json` names the installed plugins.
 *
 * Writes go through the `yaml` Document API rather than a stringify of a parsed
 * object, so the file's own comments and layout survive a sync that only meant to
 * change one provider.
 */

import { readFile, writeFile, rename, mkdir, stat, readdir, unlink, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { parseDocument, isMap, isScalar, isSeq, YAMLMap } from 'yaml'
import type { Document } from 'yaml'
import { hashJson } from './crypto.js'
import {
  BACKUP_EXT,
  type DefaultsPart,
  type ModelsPart,
  type PatchEntry,
  type PatchPart,
  type PluginsPart,
} from './wire.js'
import type { ResolvedPaths } from './paths.js'

/** The profile patch row holding the model catalog. */
export const MODELS_ID = 'llm-pi-ai'
/** The profile patch row holding the default model. */
export const DEFAULTS_ID = 'agent-default-model'
/** Package whose patch row the plugin adds for itself; never carried as a part. */
export const SELF_ID = 'dsh-webdav-sync'
/** Package names that are the DSH shell itself, not installed plugins. */
const BUILTIN_PREFIX = '@deepseek-ai/dsh-'

/** One row of the profile patch, as it is carried between computers. */
export interface PatchRow {
  /** Stable identity: `id:<id>` for a row, `insert:<inner ids>` for an insert block. */
  key: string
  /** The row as plain JSON. */
  value: PatchEntry
}

/** A profile patch, parsed and kept as a document so a write preserves the file. */
export interface PatchFile {
  document: Document
  rows: PatchRow[]
  /** The bytes read, for the changed-since check and for keeping a copy. */
  text: string
  /** The file's modification time, used as the merge's tie-breaker. */
  mtimeMs: number
}

/** The profile manifest, kept as plain JSON with its original key order. */
export interface ManifestFile {
  value: Record<string, unknown>
  text: string
  mtimeMs: number
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Read and parse the profile patch. A missing file reads as an empty patch. */
export async function readPatch(paths: ResolvedPaths): Promise<PatchFile> {
  let text = ''
  let mtimeMs = 0
  try {
    text = await readFile(paths.patchFile, 'utf8')
    mtimeMs = (await stat(paths.patchFile)).mtimeMs
  } catch (cause) {
    if (!isMissing(cause)) throw cause
  }
  const document = parseDocument(text, { keepSourceTokens: false })
  if (document.errors.length > 0) {
    const first = document.errors[0]
    throw new Error(`${paths.patchFile} 不是可读的 YAML：${first?.message ?? '未知错误'}`)
  }
  const contents = document.contents
  const rows: PatchRow[] = []
  if (isSeq(contents)) {
    contents.items.forEach((item) => {
      if (!isMap(item)) return
      const value = item.toJSON() as PatchEntry
      rows.push({ key: keyOf(value), value })
    })
  } else if (contents !== null && contents !== undefined) {
    throw new Error(`${paths.patchFile} 的顶层必须是一串 patch 行`)
  }
  return { document, rows, text, mtimeMs }
}

/** Read the profile manifest. A missing file reads as an empty manifest. */
export async function readManifest(paths: ResolvedPaths): Promise<ManifestFile> {
  let text = ''
  let mtimeMs = 0
  try {
    text = await readFile(paths.packageFile, 'utf8')
    mtimeMs = (await stat(paths.packageFile)).mtimeMs
  } catch (cause) {
    if (!isMissing(cause)) throw cause
    return { value: {}, text: '', mtimeMs: 0 }
  }
  let value: Record<string, unknown>
  try {
    value = JSON.parse(text) as Record<string, unknown>
  } catch (cause) {
    throw new Error(`${paths.packageFile} 不是可读的 JSON：${message(cause)}`)
  }
  return { value, text, mtimeMs }
}

// ---------------------------------------------------------------------------
// Collecting the parts
// ---------------------------------------------------------------------------

/** Every part of a profile this plugin can carry, as collected from disk. */
export interface Collected {
  models?: ModelsPart
  defaults?: DefaultsPart
  plugins?: PluginsPart
  patch?: PatchPart
}

/**
 * Gather the parts from one profile.
 *
 * A part is left out entirely when the profile holds nothing for it, so a
 * computer that has never configured models never claims the model part — which
 * is what lets the other computer's catalog come in untouched on a first sync.
 */
export function collect(patch: PatchFile, manifest: ManifestFile): Collected {
  const out: Collected = {}

  const modelsRow = patch.rows.find((row) => row.key === `id:${MODELS_ID}`)
  if (modelsRow !== undefined) {
    const config = modelsRow.value.config
    out.models = { config: isPlainObject(config) ? (config as Record<string, unknown>) : {} }
  }

  const defaultsRow = patch.rows.find((row) => row.key === `id:${DEFAULTS_ID}`)
  if (defaultsRow !== undefined) {
    const config = defaultsRow.value.config
    out.defaults = { config: isPlainObject(config) ? (config as Record<string, unknown>) : {} }
  }

  const dependencies = manifest.value.dependencies
  const bundles = readBundles(manifest.value)
  if (isPlainObject(dependencies) || bundles.length > 0) {
    out.plugins = {
      dependencies: isPlainObject(dependencies) ? (dependencies as Record<string, string>) : {},
      bundles,
    }
  }

  const entries = patch.rows
    .filter((row) => row.key !== `id:${MODELS_ID}` && row.key !== `id:${DEFAULTS_ID}` && row.key !== `id:${SELF_ID}`)
    .map((row) => row.value)
  if (entries.length > 0) out.patch = { entries }

  return out
}

/** `dsh.profile.bundles` from a manifest, as strings. */
export function readBundles(manifest: Record<string, unknown>): string[] {
  const dsh = manifest.dsh
  if (!isPlainObject(dsh)) return []
  const profile = (dsh as Record<string, unknown>).profile
  if (!isPlainObject(profile)) return []
  const bundles = (profile as Record<string, unknown>).bundles
  if (!Array.isArray(bundles)) return []
  return bundles.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * The plugins a manifest declares that a set of installed package names does not
 * have. Built-in shell packages are skipped: they ship with DSH, not with the
 * profile.
 */
export function missingPlugins(plugins: PluginsPart | undefined, installed: readonly string[]): string[] {
  if (plugins === undefined) return []
  const have = new Set(installed)
  const wanted = new Set<string>()
  for (const name of Object.keys(plugins.dependencies)) wanted.add(name)
  for (const name of plugins.bundles) wanted.add(name)
  return [...wanted].filter((name) => !have.has(name) && !name.startsWith(BUILTIN_PREFIX)).sort()
}

// ---------------------------------------------------------------------------
// Applying the parts
// ---------------------------------------------------------------------------

/**
 * Rewrite the profile patch so it holds the merged parts.
 *
 * Model and default rows are replaced in place when they exist and appended when
 * they do not; the remaining rows are replaced wholesale by the merged list, with
 * the model rows kept where they were. A no-op merge leaves the bytes untouched,
 * so a sync that changed nothing does not rewrite the file.
 */
export function applyPatch(patch: PatchFile, parts: { models?: ModelsPart | null; defaults?: DefaultsPart | null; patch?: PatchPart }): string {
  const document = patch.document
  const contents = document.contents
  if (!isSeq(contents)) {
    const rows: unknown[] = []
    if (parts.models !== undefined && parts.models !== null) {
      rows.push({ id: MODELS_ID, name: '@deepseek-ai/dsh-llm-pi-ai', config: parts.models.config })
    }
    if (parts.defaults !== undefined && parts.defaults !== null) {
      rows.push({ id: DEFAULTS_ID, name: '@deepseek-ai/dsh-agent-default-model', config: parts.defaults.config })
    }
    if (parts.patch !== undefined) rows.push(...parts.patch.entries)
    const replacement = document.createNode(rows)
    document.contents = replacement
    return document.toString()
  }

  // What the document held before the merge, so a merge that decided nothing
  // can hand back the original bytes. Re-serialising an untouched document is
  // not byte-stable — YAML writes `[text, image]` back as `[ text, image ]` —
  // and a sync that rewrote a person's file without changing anything in it
  // would be a sync that lied about what it did.
  const before = nodeJson(contents)

  const byKey = new Map<string, { node: YAMLMap; index: number }>()
  contents.items.forEach((item, index) => {
    if (!isMap(item)) return
    const value = item.toJSON() as PatchEntry
    byKey.set(keyOf(value), { node: item, index })
  })

  // 1. Replace or append the two id-targeted model rows.
  for (const [id, part] of [
    [MODELS_ID, parts.models] as const,
    [DEFAULTS_ID, parts.defaults] as const,
  ]) {
    if (part === undefined) continue
    const existing = byKey.get(`id:${id}`)
    if (part === null) {
      // The other computer took the row away, and that is the merge: a part that
      // was removed there has to leave here, or the two never converge.
      if (existing !== undefined) {
        const at = contents.items.indexOf(existing.node)
        if (at !== -1) contents.items.splice(at, 1)
      }
      continue
    }
    if (existing !== undefined) {
      // Replace the config node only when it actually differs, and then merge
      // into it rather than rebuilding: the catalog holds the user's own
      // comments about their providers. `keepScalar` keeps the node itself.
      //
      // A hand-written row may carry no `config:` key at all — an id, a name and
      // nothing else. There is then no node to merge into, and merging into an
      // absent one hashed `undefined` and threw. The part's config arrives whole
      // instead, and only when it has something in it, so a row that merely
      // lacked the key does not gain an empty one.
      const config = existing.node.has('config') ? existing.node.get('config', true) : undefined
      if (config === undefined) {
        if (Object.keys(part.config).length > 0) {
          existing.node.set('config', document.createNode(part.config))
        }
      } else if (!sameJson(config, part.config)) {
        existing.node.set('config', mergeInto(document, config, part.config))
      }
    } else {
      const row = document.createNode({ id, name: defaultNameFor(id), config: part.config }) as YAMLMap
      contents.items.push(row)
    }
  }

  // 2. Replace the remaining rows with the merged list, leaving the model rows
  //    and this plugin's own row where they stand.
  if (parts.patch !== undefined) {
    const keep: unknown[] = []
    const wanted = parts.patch.entries
    const wantedByKey = new Map(wanted.map((entry) => [keyOf(entry), entry] as const))
    const placed = new Set<string>()

    // Kept in the list so a row the plugin does not understand — a comment, a
    // scalar, an `!!js` expression that parsed to a plain node — is not dropped
    // from the profile by a sync that only meant to add a provider.
    for (const item of contents.items) {
      if (!isMap(item)) {
        keep.push(item)
        continue
      }
      const value = item.toJSON() as PatchEntry
      const key = keyOf(value)
      if (key === `id:${MODELS_ID}` || key === `id:${DEFAULTS_ID}` || key === `id:${SELF_ID}`) {
        keep.push(item)
        continue
      }
      const wantedEntry = wantedByKey.get(key)
      if (wantedEntry === undefined) continue
      placed.add(key)
      // Merge into the existing row when it is the same shape, so the row's own
      // comments and quoting survive; rebuild only when it is a different thing.
      keep.push(mergeInto(document, item, wantedEntry))
    }
    for (const entry of wanted) {
      const key = keyOf(entry)
      if (placed.has(key) || key === `id:${MODELS_ID}` || key === `id:${DEFAULTS_ID}` || key === `id:${SELF_ID}`) continue
      keep.push(document.createNode(entry))
    }
    contents.items = keep
  }

  // A merge that decided nothing hands back the file it was given. The document
  // was re-serialised from its own nodes, and that alone is not byte-stable —
  // YAML prints `[text, image]` back as `[ text, image ]` — so writing the
  // result would rewrite a person's file without having changed anything in it.
  if (sameJson(nodeJson(document.contents), before)) return patch.text

  return document.toString()
}

/** The loader `name` a row carries when this plugin has to create it. */
function defaultNameFor(id: string): string {
  return id === MODELS_ID ? '@deepseek-ai/dsh-llm-pi-ai' : '@deepseek-ai/dsh-agent-default-model'
}

/**
 * Rewrite the profile manifest with merged plugin declarations, two-space
 * indented.
 *
 * The declaration is mirrored rather than merged: a plugin another computer
 * removed goes from here too, or the two manifests never converge and every sync
 * would push again. Nothing is uninstalled — `node_modules` is not synced — so
 * what leaves is a line in a file, not a package.
 */
export function applyManifest(manifest: ManifestFile, plugins: PluginsPart): string {
  const value = manifest.value
  value.dependencies = sortKeys(plugins.dependencies)

  const dsh = isPlainObject(value.dsh) ? { ...(value.dsh as Record<string, unknown>) } : {}
  const profile = isPlainObject(dsh.profile) ? { ...(dsh.profile as Record<string, unknown>) } : {}
  profile.bundles = plugins.bundles
  dsh.profile = profile
  value.dsh = dsh

  return `${JSON.stringify(value, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Write bytes only when they differ from what is already there. */
export async function writeIfChanged(file: string, data: string | Uint8Array): Promise<boolean> {
  let previous: Buffer | undefined
  try {
    previous = await readFile(file)
  } catch (cause) {
    if (!isMissing(cause)) throw cause
    // A file that is not there is not the same as one holding no bytes: it has
    // to be created, and an empty carried file would otherwise never appear.
    previous = undefined
  }
  const next = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
  if (previous !== undefined && previous.equals(next)) return false
  await writeAtomic(file, next)
  return true
}

/**
 * Write a file by writing a sibling and renaming it over the target, so a crash
 * or a power cut leaves either the old file or the new one and never half of
 * either. The temporary file is removed when the write fails.
 */
export async function writeAtomic(file: string, data: string | Uint8Array, mode?: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = join(dirname(file), `.${basenameOf(file)}.${randomBytes(6).toString('hex')}.tmp`)
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
  try {
    await writeFile(temporary, body, mode === undefined ? undefined : { mode })
    if (mode !== undefined) await chmod(temporary, mode)
    await rename(temporary, file)
  } catch (cause) {
    await unlink(temporary).catch(() => undefined)
    throw cause
  }
}

/**
 * The last stamp `keepAside` handed out.
 *
 * Milliseconds are part of the name on purpose: two copies kept in the same
 * second would otherwise land on one filename, and the second would silently
 * destroy the first — which is the copy an undo points at. A millisecond is not
 * a guarantee either (eight copies land inside one on a fast filesystem), so the
 * stamp never repeats and never goes backwards: a call that would reuse the
 * previous millisecond takes the next one instead.
 */
let lastAsideAt = 0

/** `<YYYYMMDD-HHMMSSmmm>` in UTC: the chronological prefix a kept copy is named with. */
function asideStamp(at: number): string {
  const moment = new Date(at)
  const seconds = moment.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  return `${seconds}${String(moment.getUTCMilliseconds()).padStart(3, '0')}`
}

/** Whether something is already at `file`. */
async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

/**
 * Keep a copy of something the plugin is about to replace, in `sync/` beside its
 * own state. The newest `keep` files matching the tag survive.
 */
export async function keepAside(dir: string, tag: string, data: string | Uint8Array, keep = 5): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  let file: string
  do {
    lastAsideAt = Math.max(Date.now(), lastAsideAt + 1)
    file = join(dir, `${asideStamp(lastAsideAt)}-${tag}${BACKUP_EXT}`)
    // A name already on disk is a millisecond an earlier run used, or one a clock
    // that stepped backwards repeated: take the next one rather than write over a
    // copy an undo may point at.
  } while (await fileExists(file))
  await writeAtomic(file, data, 0o600)
  const names = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => name.endsWith(`-${tag}${BACKUP_EXT}`))
    .sort()
  for (const stale of names.slice(0, Math.max(0, names.length - keep))) {
    await unlink(join(dir, stale)).catch(() => undefined)
  }
  return file
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * A patch row's stable key.
 *
 * An `insert:` block is keyed by the ids of the rows it inserts, which is what
 * makes it the same block on two computers that wrote it separately. An
 * insert block whose rows carry no ids has no such name, and keying it by its
 * position of `?`s would give every such block the one key `insert:?` — two
 * different blocks would be read as one row, and a merge would write one
 * block's contents into the other. Those are keyed by their own content
 * instead, exactly like any other row that has neither id nor usable insert.
 */
export function keyOf(entry: PatchEntry): string {
  if (typeof entry.id === 'string' && entry.id !== '') return `id:${entry.id}`
  if (Array.isArray(entry.insert)) {
    const ids = entry.insert.map((row) =>
      isPlainObject(row) && typeof (row as { id?: unknown }).id === 'string' && (row as { id: string }).id !== ''
        ? (row as { id: string }).id
        : undefined,
    )
    if (ids.every((id): id is string => id !== undefined)) return `insert:${ids.join(',')}`
  }
  // A patch row normally carries an id or an insert list of id-carrying rows.
  // Anything else is keyed by its own content so it still survives a round trip
  // rather than colliding with every other anonymous row.
  return `row:${hashJson(entry)}`
}

/** `true` for a value that is a plain object rather than an array or null. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether two values from a YAML document hold the same data.
 *
 * A node read back out of a Document is not a plain object, so this normalises
 * through JSON before comparing. It is what lets a sync tell "the merge decided
 * the same thing" from "the merge decided something new", and therefore skip a
 * write that would only reformat the file.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  return hashJson(nodeJson(a)) === hashJson(nodeJson(b))
}

/** A YAML node's plain value, or the value itself when it is already plain. */
function nodeJson(value: unknown): unknown {
  if (isScalar(value)) return value.value
  if (isMap(value) || isSeq(value)) return value.toJSON()
  return value
}

/**
 * Write `value` into `node`, keeping every comment and quote that is still
 * describing the same thing.
 *
 * A sync usually changes one key — a model id, an effort level — and the file
 * around it is a person's own work: their comments, their ordering, their
 * quoting. Rebuilding the row from plain JSON would lose all of it, so a map
 * whose keys are unchanged in name and order is walked key by key, and a scalar
 * that only changed value is written onto the node it already sits on. Anything
 * whose shape changed enough that "the same node" is no longer meaningful is
 * rebuilt.
 */
function mergeInto(document: Document, node: unknown, value: unknown): unknown {
  // Nothing to do when the node already says exactly this. Returning it
  // untouched is what keeps a sync that decided nothing from even re-printing
  // the document, let alone moving a comment.
  if (sameJson(nodeJson(node), value)) return node

  if (isMap(node) && isPlainObject(value)) {
    const keys = Object.keys(value)
    const wanted = new Set(keys)
    // Drop keys the merged row no longer carries — a plugin removed on another
    // computer has to leave, not linger.
    for (const pair of [...node.items]) {
      const key = isScalar(pair.key) ? String(pair.key.value) : ''
      if (key !== '' && !wanted.has(key)) node.delete(key)
    }
    for (const key of keys) {
      // `keepScalar` is load-bearing: a plain `get` unwraps a Scalar to its
      // value, and the comment lives on the Scalar, so merging into the unwrapped
      // value would rebuild the node and quietly drop the comment with it.
      const existing = node.has(key) ? node.get(key, true) : undefined
      // A key the node never had is added whole; a key it has is walked, so the
      // comments attached to whatever did not change stay attached.
      node.set(key, existing === undefined ? document.createNode(value[key]) : mergeInto(document, existing, value[key]))
    }
    return node
  }

  if (isSeq(node) && Array.isArray(value)) {
    // Per index, so a model added to the end keeps every earlier model's own
    // comments; anything longer than the merged list is dropped.
    const shared = Math.min(node.items.length, value.length)
    for (let index = 0; index < shared; index += 1) {
      node.items[index] = mergeInto(document, node.items[index], value[index])
    }
    for (let index = shared; index < value.length; index += 1) {
      node.items.push(document.createNode(value[index]))
    }
    if (node.items.length > value.length) node.items.length = value.length
    return node
  }

  if (isScalar(node) && (value === null || typeof value !== 'object')) {
    if (sameJson(node.value, value)) return node
    // Written onto the existing Scalar so its own comment stays attached.
    node.value = value
    return node
  }

  return document.createNode(value)
}

/** An object's keys in sorted order, so a rewritten manifest is stable. */
export function sortKeys(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) out[key] = value[key]
  return out
}

/** A filesystem error meaning "there is nothing there". */
export function isMissing(cause: unknown): boolean {
  return isPlainObject(cause) && (cause as { code?: unknown }).code === 'ENOENT'
}

/**
 * An error's message, said in one line, with whatever it was caused by.
 *
 * A wrapper's own message is the vaguest part of it — "fetch failed" and
 * "reading dsh-profile.prop" name the attempt, while the cause underneath
 * says `ECONNREFUSED` or the parse error, and that is what a reader needs. The
 * chain is followed rather than only read at the top, since the ends that were
 * wrapped twice on the way up are the ones with the reason in them. The walk is
 * bounded and watches for repeats, because a cause pointing back at itself would
 * otherwise turn one sentence into a hang.
 */
export function message(cause: unknown): string {
  const seen = new Set<unknown>()
  const said: string[] = []
  let current: unknown = cause
  while (current !== undefined && current !== null && !seen.has(current) && said.length < 5) {
    seen.add(current)
    if (current instanceof Error) {
      if (current.message !== '') said.push(current.message)
      current = (current as { cause?: unknown }).cause
    } else {
      said.push(String(current))
      current = undefined
    }
  }
  if (said.length === 0) return String(cause)
  // A cause that only repeats what its wrapper said adds nothing.
  const parts: string[] = []
  for (const part of said) if (!parts.includes(part)) parts.push(part)
  return parts.join(' — ')
}

/** A path's final segment. */
function basenameOf(file: string): string {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return cut === -1 ? file : file.slice(cut + 1)
}
