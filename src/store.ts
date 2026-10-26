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
 * The default-model row is read here only to be kept out of the sync: it is one of
 * the rows a sync never carries and never writes, like this plugin's own row. See
 * `docs/decisions/0056-drop-default-model-part.md`.
 *
 * Writes go through the `yaml` Document API rather than a stringify of a parsed
 * object, so the file's own comments and layout survive a sync that only meant to
 * change one provider.
 */

import { readFile, rename, mkdir, stat, readdir, unlink, open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { parseDocument, isMap, isScalar, isSeq, YAMLMap } from 'yaml'
import type { Document, Pair } from 'yaml'
import { hashJson } from './crypto.js'
import {
  BACKUP_EXT,
  type KeysPart,
  type McpPart,
  type ModelsPart,
  type PatchEntry,
  type PatchPart,
  type PluginsPart,
} from './wire.js'
import type { ResolvedPaths } from './paths.js'

/** The profile patch row holding the model catalog. */
export const MODELS_ID = 'llm-pi-ai'
const MODELS_NAME = '@deepseek-ai/dsh-llm-pi-ai'

/** A model override the built-in Loader entry accepts (not an insert or a name mismatch). */
export function isModelOverride(entry: PatchEntry): boolean {
  return entry.id === MODELS_ID && entry.insert === undefined && (!entry.name || entry.name === MODELS_NAME)
}

/** The profile patch row holding the default model; kept out of every part. */
export const DEFAULTS_ID = 'agent-default-model'
/** Package whose patch row the plugin adds for itself; never carried as a part. */
export const SELF_ID = 'dsh-webdav-sync'
/** Package names that are the DSH shell itself, not installed plugins. */
const BUILTIN_PREFIX = '@deepseek-ai/dsh-'

/** Package whose patch rows carry MCP server registrations. */
const MCP_NAME = '@deepseek-ai/dsh-mcp-client'

/**
 * Whether a patch row belongs to the `mcp` part.
 *
 * The panel writes an MCP server as a row naming `dsh-mcp-client` — a row of its
 * own, or one inside an `insert:` block of nothing but such rows. The block is
 * the unit: half a row never moves to a part of its own, so a block mixing MCP
 * rows with others stays in `patch` whole and travels with it.
 *
 * This classification is the whole of the `mcp` part's wire format, which is to
 * say it has none: the rows travel inside `patch` exactly as before and are
 * lifted back out on read. See
 * `docs/decisions/0075-mcp-and-skills-parts.md`.
 */
export function isMcpEntry(entry: PatchEntry): boolean {
  if (!isPlainObject(entry)) return false
  const record = entry as Record<string, unknown>
  if (record.name === MCP_NAME) return true
  // A block is id-less; a row with an id is its own row, already judged by name.
  if (record.id !== undefined) return false
  const insert = record.insert
  if (!Array.isArray(insert) || insert.length === 0) return false
  return insert.every((item) => isPlainObject(item) && (item as Record<string, unknown>).name === MCP_NAME)
}

/** The rows split into the patch part's and the `mcp` part's, each keeping its order. */
export function splitMcp(entries: readonly PatchEntry[]): { rest: PatchEntry[]; mcp: PatchEntry[] } {
  const rest: PatchEntry[] = []
  const mcp: PatchEntry[] = []
  for (const entry of entries) (isMcpEntry(entry) ? mcp : rest).push(entry)
  return { rest, mcp }
}

/**
 * The rows as one list — the patch part's first, then the `mcp` part's — which
 * is how a bundle's `patch` field is built.
 *
 * A computer running a version that does not know the `mcp` part then sees
 * exactly the rows it saw before, in a shape its own merge handles; this version
 * lifts them back out on read (`splitMcp(joinMcp(rest, mcp))` is `{rest, mcp}`).
 */
export function joinMcp(rest: readonly PatchEntry[], mcp: readonly PatchEntry[]): PatchEntry[] {
  return [...rest, ...mcp]
}

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
  return readPatchAt(paths.patchFile)
}

/**
 * Read the home patch DSH layers over the profile, or `undefined` when this
 * machine has none.
 *
 * A machine that never wrote one is the ordinary case, so a missing file is not
 * an empty patch to be written back: it is a layer that does not exist, and
 * copying the server's catalog into it would take the catalog away from the
 * profile patch that does have one.
 */
export async function readHomePatch(paths: ResolvedPaths): Promise<PatchFile | undefined> {
  const file = paths.homePatchFile
  if (file === undefined) return undefined
  return readPatchAt(file, { optional: true })
}

/**
 * The same patch with its model-catalog rows taken out, and nothing else touched.
 *
 * This is the one write a sync makes outside the profile: a home patch that
 * declares a catalog of its own hides the one synced into the profile, so the
 * shadow is dropped and the profile row applies again. Every other row — and the
 * comments on them — stays exactly where it was, and a file with no model row
 * comes back byte for byte.
 *
 * A file left with no rows at all becomes `[]` rather than empty: DSH parses a
 * patch file as a top-level array and refuses anything else, empty file included.
 */
export function withoutModels(patch: PatchFile): string {
  const contents = patch.document.contents
  if (!isSeq(contents)) return patch.text
  const keep = contents.items.filter(item => !isMap(item) || !isModelOverride(item.toJSON() as PatchEntry))
  if (keep.length === contents.items.length) return patch.text
  contents.items = keep
  return keep.length === 0 ? '[]\n' : patch.document.toString()
}

/** Read and parse one patch file, by path. */
async function readPatchAt(file: string, options: { optional: true }): Promise<PatchFile | undefined>
async function readPatchAt(file: string): Promise<PatchFile>
async function readPatchAt(file: string, options: { optional?: boolean } = {}): Promise<PatchFile | undefined> {
  let text = ''
  let mtimeMs = 0
  try {
    text = await readFile(file, 'utf8')
    mtimeMs = (await stat(file)).mtimeMs
  } catch (cause) {
    if (!isMissing(cause)) throw cause
    if (options.optional === true) return undefined
  }
  const document = parseDocument(text, { keepSourceTokens: false })
  if (document.errors.length > 0) {
    const first = document.errors[0]
    throw new Error(`${file} 不是可读的 YAML：${first?.message ?? '未知错误'}`)
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
    throw new Error(`${file} 的顶层必须是一串 patch 行`)
  }
  return { document, rows, text, mtimeMs }
}

/**
 * Which patch file DSH takes the model catalog from.
 *
 * The home patch is composed after the profile's and its `config` replaces the
 * profile row's wholesale, so a model row with a `config` there is the one in
 * force; without one the profile's row is. A row without `config` only changes
 * metadata and hides nothing — the same rule {@link collect} applies per file.
 */
export function modelsLayer(profile: PatchFile, home: PatchFile | undefined): PatchFile {
  if (home === undefined) return profile
  return home.rows.some(row => isModelOverride(row.value) && Object.hasOwn(row.value, 'config')) ? home : profile
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
  plugins?: PluginsPart
  /**
   * The patch rows that are not the `mcp` part's. The two are one file here and
   * two parts everywhere else — see {@link splitMcp}.
   */
  patch?: PatchPart
  /** The MCP rows lifted out of the patch file's other rows. */
  mcp?: McpPart
  /**
   * The keys, added by `take` rather than here: they are the one part that does
   * not come from a profile file. Left out entirely when this computer holds
   * nothing for any name the profile uses — the same "no opinion" an absent
   * `models` carries, so the server's copy is carried through untouched.
   */
  keys?: KeysPart
}

/**
 * Gather the parts from one profile.
 *
 * A part is left out entirely when the profile holds nothing for it, so a
 * computer that has never configured models never claims the model part — which
 * is what lets the other computer's catalog come in untouched on a first sync.
 *
 * `modelsIn` is the patch file DSH takes the catalog from, when that is not the
 * profile patch — see {@link modelsLayer}. The other rows always come from the
 * profile patch: the home layer is this machine's own, not a profile's setup.
 */
export function collect(patch: PatchFile, manifest: ManifestFile, modelsIn: PatchFile = patch): Collected {
  const out: Collected = {}

  // Loader applies overrides in order and replaces `config` wholesale. A later
  // row without that key only changes metadata; it must not hide the catalog.
  const modelRows = modelsIn.rows.filter(row => isModelOverride(row.value))
  const modelsRow = modelRows.findLast(row => Object.hasOwn(row.value, 'config')) ?? modelRows.at(-1)
  if (modelsRow !== undefined) {
    const config = modelsRow.value.config
    out.models = { config: isPlainObject(config) ? (config as Record<string, unknown>) : {} }
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
  // The MCP rows are this computer's `mcp` part, not its `patch`: the two travel
  // in one field and are told apart by name — see {@link splitMcp}. Each is left
  // out when empty, so neither part is ever claimed by a computer that has
  // nothing for it.
  const { rest, mcp } = splitMcp(entries)
  if (rest.length > 0) out.patch = { entries: rest }
  if (mcp.length > 0) out.mcp = { entries: mcp }

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

/**
 * A model catalog as the sync weighs it, with the order of the provider list
 * kept.
 *
 * `resolveProfiles` walks `Object.entries(providers)` in declaration order, so
 * that order is part of the catalog we mirror. It is not merely YAML layout:
 * `hashJson` sorts object keys, which would hide a move from every "did this
 * change?" question. The routes are therefore handed over as `[name, route]`
 * pairs; every other object key stays order-insensitive. The host may apply its
 * own presentation rules (account/official priority or a cached registration
 * order); syncing the catalog cannot override those rules.
 *
 * See `docs/decisions/0063-keep-provider-order.md`.
 */
function catalogIdentity(config: unknown): unknown {
  if (!isPlainObject(config)) return config
  const value = config as Record<string, unknown>
  if (!isPlainObject(value.providers)) return config
  return { ...value, providers: Object.entries(value.providers as Record<string, unknown>) }
}

/**
 * A `models` part with its catalog's provider order made significant, for hashing
 * and for comparing a merged catalog against the one in the file.
 */
export function modelsIdentity(part: unknown): unknown {
  if (!isPlainObject(part)) return part
  const value = part as Record<string, unknown>
  return { ...value, config: catalogIdentity(value.config) }
}

/** The provider names of a catalog, in the order the catalog lists them. */
function providerOrder(config: unknown): string[] {
  if (!isPlainObject(config)) return []
  const providers = (config as Record<string, unknown>).providers
  return isPlainObject(providers) ? Object.keys(providers as Record<string, unknown>) : []
}

// ---------------------------------------------------------------------------
// Applying the parts
// ---------------------------------------------------------------------------

/**
 * Rewrite the profile patch so it holds the merged parts.
 *
 * The model row is replaced in place when it exists and appended when it does not;
 * the remaining rows are replaced wholesale by the merged lists — one for the
 * `patch` rows and one for the `mcp` rows the same file carries (see
 * {@link splitMcp}), each left alone when it is not part of this merge — with the
 * model, the default-model and this plugin's own rows kept where they were. A
 * no-op merge leaves the bytes untouched, so a sync that changed nothing does not
 * rewrite the file.
 */
export function applyPatch(
  patch: PatchFile,
  parts: { models?: ModelsPart | null; patch?: PatchPart; mcp?: McpPart },
): string {
  const document = patch.document
  const contents = document.contents
  if (!isSeq(contents)) {
    const rows: unknown[] = []
    if (parts.models !== undefined && parts.models !== null) {
      rows.push({ id: MODELS_ID, name: MODELS_NAME, config: parts.models.config })
    }
    if (parts.patch !== undefined) rows.push(...parts.patch.entries)
    if (parts.mcp !== undefined) rows.push(...parts.mcp.entries)
    const replacement = document.createNode(rows)
    document.contents = replacement
    return document.toString()
  }

  // What the document held before the merge, so a merge that decided nothing
  // can hand back the original bytes. Re-serialising an untouched document is
  // not byte-stable — YAML writes `[text, image]` back as `[ text, image ]` —
  // and a sync that rewrote a person's file without changing anything in it
  // would be a sync that lied about what it did. Read through `documentJson`
  // rather than raw, so a merge whose only decision was a reordered provider
  // list is still seen as a change.
  const before = documentJson(contents)

  const modelNodes = contents.items.filter((item): item is YAMLMap =>
    isMap(item) && isModelOverride(item.toJSON() as PatchEntry),
  )

  // 1. Replace or append the effective model config. Metadata-only rows after it
  //    do not supersede it, just as they do not supersede it when Loader reads.
  const modelPart = parts.models
  if (modelPart !== undefined) {
    const existing = modelNodes.findLast(node => node.has('config')) ?? modelNodes.at(-1)
    if (modelPart === null) {
      // Removing only the last override would expose an earlier, stale catalog.
      const removed = new Set<unknown>(modelNodes)
      contents.items = contents.items.filter(item => !removed.has(item))
    } else if (existing !== undefined) {
      // Replace the config node only when it actually differs, and then merge
      // into it rather than rebuilding: the catalog holds the user's own
      // comments about their providers. `keepScalar` keeps the node itself.
      //
      // A hand-written row may carry no `config:` key at all — an id, a name and
      // nothing else. There is then no node to merge into, and merging into an
      // absent one hashed `undefined` and threw. The part's config arrives whole
      // instead, and only when it has something in it, so a row that merely
      // lacked the key does not gain an empty one.
      const config = existing.has('config') ? existing.get('config', true) : undefined
      if (config === undefined) {
        if (Object.keys(modelPart.config).length > 0) {
          existing.set('config', document.createNode(modelPart.config))
        }
      } else if (!sameJson(catalogIdentity(nodeJson(config)), catalogIdentity(modelPart.config))) {
        // The merge walks the merged catalog's keys, and a key the file already
        // had keeps the place it had — which is what keeps a comment attached to
        // the provider it describes. The provider list is the exception: DSH
        // lists the routes in the order the map names them, so the order the
        // merge decided has to be written as well as noticed.
        const merged = mergeInto(document, config, modelPart.config)
        existing.set('config', merged)
        reorderProviders(merged, providerOrder(modelPart.config))
      }
    } else {
      const row = document.createNode({ id: MODELS_ID, name: MODELS_NAME, config: modelPart.config }) as YAMLMap
      contents.items.push(row)
    }
  }

  // 2. Replace the rows of each class the merge decided on, leaving the model
  //    rows, this plugin's own row, and every class it did not touch exactly
  //    where they stand. The `mcp` rows are a class of their own inside the same
  //    list: the file holds both parts and the wire carries one field — see
  //    {@link splitMcp}.
  if (parts.patch !== undefined || parts.mcp !== undefined) {
    const keep: unknown[] = []
    const rest = parts.patch?.entries ?? []
    const mcp = parts.mcp?.entries ?? []
    const restByKey = new Map(rest.map((entry) => [keyOf(entry), entry] as const))
    const mcpByKey = new Map(mcp.map((entry) => [keyOf(entry), entry] as const))
    const placedRest = new Set<string>()
    const placedMcp = new Set<string>()

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
      // A row whose class the merge did not decide on stays exactly as it is —
      // which is what lets `mcp` change while `patch` is left alone, and the
      // other way round.
      const asMcp = isMcpEntry(value)
      const wanted = asMcp ? parts.mcp : parts.patch
      if (wanted === undefined) {
        keep.push(item)
        continue
      }
      const wantedEntry = (asMcp ? mcpByKey : restByKey).get(key)
      if (wantedEntry === undefined) continue
      ;(asMcp ? placedMcp : placedRest).add(key)
      // Merge into the existing row when it is the same shape, so the row's own
      // comments and quoting survive; rebuild only when it is a different thing.
      keep.push(mergeInto(document, item, wantedEntry))
    }
    for (const [entries, placed, wanted] of [
      [rest, placedRest, parts.patch],
      [mcp, placedMcp, parts.mcp],
    ] as const) {
      if (wanted === undefined) continue
      for (const entry of entries) {
        const key = keyOf(entry)
        if (placed.has(key) || key === `id:${MODELS_ID}` || key === `id:${DEFAULTS_ID}` || key === `id:${SELF_ID}`) {
          continue
        }
        keep.push(document.createNode(entry))
      }
    }
    contents.items = keep
  }

  // A merge that decided nothing hands back the file it was given. The document
  // was re-serialised from its own nodes, and that alone is not byte-stable —
  // YAML prints `[text, image]` back as `[ text, image ]` — so writing the
  // result would rewrite a person's file without having changed anything in it.
  // The comparison goes through `documentJson`, since a reordered provider list
  // is a decision even though sorted hashing of the raw rows cannot see it.
  if (sameJson(documentJson(document.contents), before)) return patch.text

  return document.toString()
}

/**
 * A patch document's rows as plain data, with the model catalog's provider order
 * kept.
 *
 * `nodeJson` alone is not enough for the "did the merge decide anything?" check at
 * the end of `applyPatch`: `sameJson` sorts object keys, so a document whose only
 * difference is the order of the routes inside `config.providers` would hash the
 * same as the one before the merge, and the reorder would be decided and then
 * thrown away with the bytes it came in.
 */
function documentJson(contents: unknown): unknown {
  const value = nodeJson(contents)
  if (!Array.isArray(value)) return value
  return value.map((entry: unknown) =>
    isPlainObject(entry) && (entry as { id?: unknown }).id === MODELS_ID
      ? { ...(entry as Record<string, unknown>), config: catalogIdentity((entry as { config?: unknown }).config) }
      : entry,
  )
}

/**
 * Put a merged catalog's provider routes into the order the merge decided.
 *
 * A route the merged catalog names keeps the position it has in `order`; anything
 * it does not name — a route DSH itself added, a duplicated key in a hand-edited
 * file — keeps its own relative order after those, so nothing is dropped and no
 * two pairs are ever collapsed into one. Comments travel with their pair, since
 * the pairs themselves are moved rather than rebuilt.
 */
function reorderProviders(config: unknown, order: readonly string[]): void {
  if (!isMap(config) || order.length === 0) return
  const providers = config.has('providers') ? config.get('providers', true) : undefined
  if (!isMap(providers)) return

  const nameOf = (pair: Pair): string => (isScalar(pair.key) ? String(pair.key.value) : '')
  const byName = new Map<string, Pair[]>()
  for (const pair of providers.items) {
    const list = byName.get(nameOf(pair))
    if (list === undefined) byName.set(nameOf(pair), [pair])
    else list.push(pair)
  }

  const placed = new Set<Pair>()
  const next: Pair[] = []
  for (const wanted of order) {
    const pair = byName.get(wanted)?.shift()
    if (pair === undefined) continue
    placed.add(pair)
    next.push(pair)
  }
  for (const pair of providers.items) if (!placed.has(pair)) next.push(pair)
  providers.items = next
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
 *
 * The bytes are flushed to the disk before the rename that makes them the file,
 * and the directory after it: a rename is atomic for the name, but the data
 * behind it reaches the platter when the OS decides unless it is asked, and a
 * power cut in that gap otherwise leaves a whole new file of zeros under a
 * name that promises it is whole. Windows has no directory handle to flush, and
 * needs none for the rename itself to be durable.
 */
export async function writeAtomic(file: string, data: string | Uint8Array, mode?: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = join(dirname(file), `.${basenameOf(file)}.${randomBytes(6).toString('hex')}.tmp`)
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
  let handle: FileHandle | undefined
  try {
    handle = await open(temporary, 'w', mode === undefined ? undefined : mode)
    await handle.writeFile(body)
    if (mode !== undefined) await handle.chmod(mode)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, file)
    const directory = await open(dirname(file), 'r').catch(() => undefined)
    if (directory !== undefined) await directory.sync().catch(() => undefined).finally(() => directory.close()).catch(() => undefined)
  } catch (cause) {
    if (handle !== undefined) await handle.close().catch(() => undefined)
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
