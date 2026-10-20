/**
 * One sync, and the three actions that go around it.
 *
 * The design comes from magpie's `internal/davsync`. The setup travels in parts,
 * each hashed on its own, and one sync is a three-way merge per part between what
 * the server last held, what it holds now, and what is here. A part changed only
 * here is pushed; one changed only there is brought in; one changed on both keeps
 * the newer and keeps the other beside it under `sync/`. What the server holds is
 * mirrored, so a row removed on one computer goes from the others too.
 *
 * The reason for each step is written where the step is, because most of them
 * exist for a case that is not obvious from the code: a server that says "no file"
 * with 409, a write that went out without the server checking its version, a body
 * a relay cut in half.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BUNDLE_APP,
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  PARTS,
  REMOTE_FILE,
  type Bundle,
  type CheckResult,
  type ConfigView,
  type DirsPart,
  type Notice,
  type Part,
  type PartHashes,
  type PartView,
  type PluginsPart,
  type PreviewChange,
  type PreviewResult,
  type StatusResult,
  type StoredState,
  type SyncConfig,
  type SyncResult,
} from './wire.js'
import { CorruptError, NotBackupError, PassphraseError, hashJson, open, seal, sum } from './crypto.js'
import { Dav, LoginError, RateLimitedError, parseHeaders, type DavRead } from './dav.js'
import { dirsDiffer, dirsPartOf, readDirs, writeDirs, type DirsRead } from './dirs.js'
import {
  applyManifest,
  applyPatch,
  collect,
  isMissing,
  keepAside,
  message,
  missingPlugins,
  readManifest,
  readPatch,
  writeIfChanged,
  type Collected,
  type ManifestFile,
  type PatchFile,
} from './store.js'
import {
  cached,
  ensureStateDir,
  keptDir,
  loadConfig,
  loadState,
  normaliseUrl,
  persistConfig,
  releasePassword,
  remember,
  sameAccount,
  saveConfig,
  saveState,
  stateKey,
  syncsPart,
  usable,
} from './state.js'
import { resolvePaths } from './paths.js'
import type { ResolvedPaths } from './paths.js'

/** The parts of one setup, as values, keyed by part name. */
type Merged = Partial<Record<Part, unknown>>

/** One read of this computer's setup, with the files it came from. */
interface Snapshot {
  patch: PatchFile
  manifest: ManifestFile
  /** The four parts that come out of the profile's own two files. */
  parts: Collected
  /** The extra directories, walked from disk, with whatever could not be read. */
  dirs: DirsRead
}

/**
 * This computer's whole setup, as parts.
 *
 * The four profile parts are read once; the extra directories have to be walked,
 * so they arrive separately and are put back together here. `carried` is the
 * server's `dirs` part, and it is used for the directories this computer could not
 * read — see {@link dirsPartOf} for why carrying those beats reading them as
 * empty ones.
 */
function partsOf(snapshot: Snapshot, carried: DirsPart | undefined): Merged {
  const dirs = dirsPartOf(snapshot.dirs, carried)
  // No directories named and none carried: the part is left out entirely rather
  // than sent as an empty one, so a computer that syncs none of them can never be
  // the one that empties the part for the computers that do.
  return dirs === undefined ? { ...snapshot.parts } : { ...snapshot.parts, dirs }
}

/** Everything a sync needs, resolved once. */
export interface Engine {
  paths: ResolvedPaths
  config: SyncConfig
}

/**
 * One operation at a time, per process.
 *
 * The state file is read, decided on and written without a lock of its own, so
 * two syncs running together would each merge against a state the other is about
 * to replace. They queue here instead. Two DSH windows at once are a different
 * matter, and are caught by the ETag check on the write.
 */
let queue: Promise<unknown> = Promise.resolve()

function serially<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  // The chain keeps going whether or not this call failed, so one failure never
  // wedges every sync after it.
  queue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

/** The engine for a profile directory and a configuration. */
export function engineFor(paths: ResolvedPaths, config: SyncConfig): Engine {
  return { paths, config }
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * Run one merge.
 *
 * `force` syncs even when neither side looks changed, which is what the card's
 * own button does: the alternative is a button that appears to do nothing.
 */
export async function sync(engine: Engine, options: { force?: boolean } = {}): Promise<SyncResult> {
  return guarded(engine, async () => {
    const { paths, config } = engine
    if (!usable(config)) throw new Error('同步还没有配置好：请先填写地址和口令')
    await ensureStateDir(paths)
    const state = await freshState(paths, config)
    const outcome = await syncOnce(engine, state, options.force === true)
    state.last = new Date().toISOString()
    state.error = ''
    await saveState(paths, state)
    return outcome
  })
}

/**
 * Run one of the four operations, recording why it failed when it does.
 *
 * The whole operation goes through {@link serially}: reading the state, deciding
 * on it and writing it back is not atomic on its own, so two of them overlapping
 * would each merge against a state the other is about to replace. Recording the
 * failure is inside the same turn for the same reason — it reads and writes the
 * state file too.
 */
async function guarded<T>(engine: Engine, work: () => Promise<T>): Promise<T> {
  return serially(async () => {
    try {
      return await work()
    } catch (cause) {
      await recordFailure(engine, cause)
      throw cause
    }
  })
}

/** The state for this configuration, emptied when it describes a different one. */
async function freshState(paths: ResolvedPaths, config: SyncConfig): Promise<StoredState> {
  const state = await loadState(paths)
  const key = stateKey(config)
  if (state.key !== key) {
    // Another folder, account or passphrase: the hashes describe a file that is
    // no longer the one being synced, so they are no baseline for anything.
    return { key }
  }
  return state
}

async function recordFailure(engine: Engine, cause: unknown): Promise<void> {
  try {
    const state = await loadState(engine.paths)
    state.last = new Date().toISOString()
    state.error = message(cause)
    // The failure is recorded against the configuration that failed, not against
    // whichever one was synced last. A wrong passphrase changes the state key and
    // so would never match the stored one — and a failed sync that left no trace
    // is the one kind of failure a person cannot act on. The baseline hashes are
    // left exactly as they are: this run learned nothing about the server.
    state.errorKey = stateKey(engine.config)
    await saveState(engine.paths, state)
  } catch {
    // Recording why a sync failed must not itself fail the call.
  }
}

/** The file on the server, opened or not, with its part hashes. */
interface RemoteSide {
  /** The hashes of what the server holds, as of the last sync or as read now. */
  hashes: PartHashes
  /** The opened bundle, when one was read. */
  body?: Bundle
  /** `bundle.created`, or the epoch when it is not known. */
  created: string
  /** The version of the file as read, for the write that may follow. */
  version: DavRead['version']
  /** True when the server said the file is unchanged and it was not sent again. */
  notModified: boolean
  /** True when the server holds no file of ours yet. */
  empty: boolean
  /**
   * True when the bytes read were damaged and are being rebuilt over, which
   * forces a write even when every part hashes as it did before.
   */
  rebuilt?: boolean
  /** One part of the server's setup, `undefined` when it does not carry it. */
  part(part: Part): unknown
}

async function syncOnce(engine: Engine, state: StoredState, force: boolean): Promise<SyncResult> {
  const { paths, config } = engine
  const dav = davOf(config)
  const read = await dav.get(state.server)

  // A write that went out without the server checking its version may have
  // overlapped another computer's, and which of the two landed cannot be told
  // from here. The state is rolled back to what it was before that write, so the
  // file on the server is merged against rather than mistaken for one already
  // seen.
  //
  // Rolling back is only right while the file on the server is still somebody
  // else's: when the bytes there are the very ones this computer wrote, nothing
  // overlapped and the hashes taken after that write are the true ones. Rolling
  // back regardless would throw away the baseline of every sync on a server that
  // answers without an ETag — the write is blind there every time — and the
  // baseline it throws away is what makes the next local edit look like an edit
  // at all. Clearing the guard either way is part of the same care: it describes
  // one write, and a guard that outlives it turns every later sync into a first
  // one.
  if (state.blind !== undefined) {
    if (read.notModified !== true && (read.data === undefined || sum(read.data) !== state.blind.sum)) {
      state.remote = state.blind.remote
      state.local = state.blind.local
    }
    state.blind = undefined
  }

  const snapshot = await take(paths, config)
  let remote = await openRemote(engine, state, read)

  const first = state.local === undefined
  // A directory could not be read this run: its part stands in for the server's
  // copy of it, and the server's copy cannot be known from a `notModified` answer
  // — so the comparison below is made without it and comes out false, which takes
  // this sync the long way round and reads the file. That is the right price for
  // not confusing "could not measure" with "measured, and it is empty".
  if (
    remote.notModified
    && sameHashes(hashesOf(partsOf(snapshot, remote.part('dirs') as DirsPart | undefined)), state.local)
    && !force
  ) {
    // Neither side moved: the last sync is still the state of the world.
    return { here: [], there: [], pushed: false, reloadNeeded: false, ...(await pendings(engine, snapshot.parts.plugins)) }
  }
  if (remote.notModified) {
    // The server said the file is the one last read, which was worth knowing for
    // the check above — but something here moved, so the file's own parts are
    // needed to merge against and it is read again, this time in full.
    remote = await openRemote(engine, state, await dav.get())
  }

  const carried = remote.part('dirs') as DirsPart | undefined
  const localParts = partsOf(snapshot, carried)
  const local = hashesOf(localParts)

  // The server holds no file of ours. This computer's setup becomes the first
  // version, which is what joining an empty folder means.
  if (remote.empty) {
    return await push(engine, state, snapshot, {
      merged: { ...localParts },
      applied: { ...localParts },
      remote: remote.hashes,
      version: remote.version,
      here: [],
      there: [],
    })
  }

  const merged: Merged = {}
  const applied: Merged = {}
  const here: Part[] = []
  const there: Part[] = []
  let conflicted = false

  for (const part of PARTS) {
    const remoteHas = remote.hashes[part] !== undefined
    const remotePart = (): unknown => remote.part(part)

    if (!syncsPart(config, part)) {
      // Not carried with this configuration. The server's copy is carried through
      // the upload untouched — turning a part off must never delete it for the
      // computers that still sync it — and nothing is written here from it.
      if (remoteHas) merged[part] = remotePart()
      continue
    }

    // A side moved when its hash for the part is not the one carried over from
    // the last sync — not merely when its presence changed. Comparing presence
    // would read an edit made only on the other computer as "unchanged" and
    // quietly keep this computer's older copy.
    const changedHere = !first && local[part] !== state.local?.[part]
    const changedThere = first || remote.hashes[part] !== state.remote?.[part]
    // A part the other computer took away is taken away here too — but never the
    // plugin list, which is what loads the shell, and never on a first sync,
    // where an absent part only means this computer has nothing to compare.
    const removable = !first && part !== 'plugins'

    if (changedHere && changedThere) {
      // Both sides moved. The newer of the two wins, compared against the stamp
      // the server wrote into the file.
      conflicted = true
      const serverAt = Date.parse(remote.created)
      const ours = localChangedAt(snapshot, part)
      if (!Number.isFinite(serverAt) || ours >= serverAt) {
        if (local[part] !== undefined) {
          merged[part] = localParts[part]
          applied[part] = localParts[part]
          there.push(part)
        }
      } else if (remoteHas) {
        merged[part] = remotePart()
        applied[part] = remotePart()
        here.push(part)
      } else if (removable) {
        // The other computer removed the part and its file is the newer one, so
        // the removal is the newer answer.
        applied[part] = null
        here.push(part)
      }
      continue
    }

    if (changedThere) {
      // Only the server moved. Its copy is brought in — including its absence,
      // which is how a part removed on another computer is removed here. `null`
      // is the instruction to take it away; leaving it `undefined` would mean
      // "do not touch", which is how a part stays that should have gone.
      if (remoteHas) {
        merged[part] = remotePart()
        applied[part] = remotePart()
        here.push(part)
      } else if (part === 'dirs' && local[part] !== undefined) {
        // The one removal this computer does not take. Its own directories are still
        // named here, and the part does nothing but say which paths travel: taking it
        // away would leave them unsynced for no gain, so the copy here is what goes
        // back up.
        merged[part] = localParts[part]
        applied[part] = localParts[part]
        there.push(part)
      } else if (removable) {
        applied[part] = null
        here.push(part)
      }
      continue
    }

    if (changedHere) {
      // Only this computer moved: the part goes up.
      if (local[part] !== undefined) {
        merged[part] = localParts[part]
        applied[part] = localParts[part]
        there.push(part)
      } else if (part === 'dirs' && remoteHas) {
        // The list of directories was emptied here. That means "stop syncing these
        // on this computer", not "everybody delete them": the part is carried
        // through as the server has it, so the computers that still name a
        // directory keep syncing it between themselves and no file anywhere is
        // removed for it.
        merged[part] = remotePart()
      }
      continue
    }

    // Neither side moved. This computer's copy is taken when it has one, so a
    // part that is present on only one side is never dropped by accident.
    if (local[part] !== undefined) {
      merged[part] = localParts[part]
      applied[part] = localParts[part]
    } else if (remoteHas) {
      merged[part] = remotePart()
      // A computer that names no directories leaves its disk alone here: writing
      // the server's list back would put files into a folder the user has just
      // taken off that list. Restore is the action that lands in such a folder,
      // and it says so on the card; an ordinary sync has nothing to write.
      if (part !== 'dirs' || config.dirs.length > 0) applied[part] = remotePart()
    }
  }

  let saved: string | undefined
  if (conflicted) saved = await keepConflict(engine, snapshot, remote, here.includes('dirs') || there.includes('dirs'))
  else if (first && here.length > 0 && !sameHashes(local, remote.hashes)) {
    // The server's setup is being taken over one this computer had, with no
    // baseline to weigh them: a join, or a state file that was lost. Either way
    // something written here is about to be replaced, so it is kept and the
    // notice says where it went — see {@link keepUnmerged} on why the sync is
    // not refused instead.
    saved = await keepUnmerged(engine, snapshot)
  }

  const mergedHashes = hashesOf(merged)
  // `force` is the card's own button: it uploads even when the merge decided
  // nothing, because a button that appears to do nothing is a button nobody
  // trusts. An ordinary sync leaves the file alone when there is nothing to say.
  // `rebuilt` overrides both: the file on the server is a fragment.
  const pushNeeded = force || remote.rebuilt === true || !sameHashes(mergedHashes, remote.hashes)
  if (!pushNeeded) {
    const written = await applyMerged(engine, snapshot, applied)
    state.remote = remote.hashes
    // Read back rather than assume: a directory whose file was just written — or
    // removed — has to be hashed as it now is, or the next sync would see an edit
    // that this one made itself and call it a conflict.
    state.local = hashesOf(partsOf(await take(paths, config), undefined))
    // A part can come in without the file needing to be written: when only the
    // server moved, the merge agrees with it. The person still has to be told
    // what changed here, so the notice is recorded on this path too — clearing
    // it would mean a sync that brought something in said nothing at all.
    state.notice =
      here.length > 0 || there.length > 0
        ? {
            at: new Date().toISOString(),
            here,
            there,
            ...(saved === undefined ? {} : { saved }),
          }
        : undefined
    return {
      here,
      there,
      ...(saved === undefined ? {} : { saved }),
      pushed: false,
      reloadNeeded: written.reloadNeeded,
      ...(await pendings(engine, applied.plugins as PluginsPart | undefined)),
    }
  }

  return await push(engine, state, snapshot, {
    merged,
    applied,
    remote: remote.hashes,
    version: remote.version,
    here,
    there,
    ...(saved === undefined ? {} : { saved }),
  })
}

/**
 * The first part of a sealed bundle whose runtime shape this version cannot read.
 *
 * A bundle is only as trustworthy as the computer that wrote it. Opening one
 * proves the passphrase was right and the bytes are intact; it says nothing about
 * whether `patch` is an entry list. Another version of this plugin could seal
 * `{ patch: { entries: 5 } }`, and the first thing to notice would be a
 * `TypeError` thrown from the middle of the merge — by which time the local files
 * have already been read and the user is shown a crash rather than a file this
 * version does not understand. The shapes are checked here instead, before
 * anything is decided on.
 *
 * Absent parts are fine: a bundle may carry any of the five.
 */
function unreadablePart(bundle: Bundle): Part | undefined {
  const isObject = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value)
  for (const part of PARTS) {
    const value: unknown = bundle[part]
    if (value === undefined) continue
    // The extra directories are an object holding the list, and an empty list is a
    // setup with none rather than a part that cannot be read.
    if (part === 'dirs') {
      if (!isObject(value)) return part
      const record = value as Record<string, unknown>
      if (!Array.isArray(record.dirs)) return part
      const readable = (one: unknown): boolean => {
        if (!isObject(one)) return false
        const dir = one as Record<string, unknown>
        if (typeof dir.path !== 'string' || !Array.isArray(dir.files)) return false
        return dir.files.every((file) => {
          if (!isObject(file)) return false
          const inner = file as Record<string, unknown>
          return typeof inner.path === 'string' && typeof inner.data === 'string'
        })
      }
      if (!record.dirs.every(readable)) return part
      continue
    }
    if (!isObject(value)) return part
    const record = value as Record<string, unknown>
    if (part === 'models' || part === 'defaults') {
      if (!isObject(record.config)) return part
      continue
    }
    if (part === 'plugins') {
      const dependencies = record.dependencies
      const bundles = record.bundles
      if (!isObject(dependencies) || !Array.isArray(bundles)) return part
      if (!Object.values(dependencies as Record<string, unknown>).every((one) => typeof one === 'string')) return part
      if (!bundles.every((one) => typeof one === 'string')) return part
      continue
    }
    // The remaining part is the leftover patch rows.
    if (!Array.isArray(record.entries)) return part
    if (!record.entries.every((one) => isObject(one) || typeof one === 'string')) return part
  }
  return undefined
}

/**
 * The server's setup, opened.
 *
 * Four things can be wrong with the bytes and they are not the same thing: the
 * wrong passphrase (nothing to do but say so), damage (a relay cut a write short,
 * which is recoverable from the copy kept here), the right file from a version of
 * this plugin whose parts this one cannot read, and something else entirely (a
 * sign-in page, another application's file — never written over without being
 * asked). Every one of them is told apart and reported as itself.
 */
async function openRemote(engine: Engine, state: StoredState, read: DavRead): Promise<RemoteSide> {
  const { paths, config } = engine
  const empty: RemoteSide = {
    hashes: {},
    created: new Date(0).toISOString(),
    version: read.version,
    notModified: false,
    empty: true,
    part: () => undefined,
  }

  if (read.notModified) {
    // The server said the file is the one last read, so the hashes from that sync
    // are still what it holds. No body is needed: nothing can come in from a file
    // that did not change.
    return { ...empty, hashes: state.remote ?? {}, empty: false, notModified: true }
  }

  let data = read.data
  if (data === undefined) data = await cached(paths, state.sum)
  if (data === undefined) return empty

  if (read.redirectedTo !== undefined) {
    throw new Error(
      `地址最终指到了别处：服务器把请求转到了 ${read.redirectedTo}。请填文件夹本身的地址`,
    )
  }

  try {
    const bundle = (await open(data, config.passphrase)) as Bundle
    if (bundle === null || typeof bundle !== 'object' || bundle.format !== BUNDLE_FORMAT) {
      throw new NotBackupError()
    }
    // A bundle this version cannot read is treated as the damaged case rather
    // than as not-ours: the passphrase opened it, so it is a backup, and refusing
    // outright would leave the user with no way forward but Write over. Route it
    // down the same branch as a half-written file, which keeps the bytes and
    // rebuilds from this computer.
    const unreadable = unreadablePart(bundle)
    if (unreadable !== undefined) {
      throw new CorruptError(`服务器上的文件是一份读不了的 dsh 同步备份：其中「${unreadable}」这一份的形状不是本插件写出来的`)
    }
    return {
      hashes: hashesOf(bundle),
      body: bundle,
      created: typeof bundle.created === 'string' ? bundle.created : new Date(0).toISOString(),
      version: read.version,
      notModified: false,
      empty: false,
      part: (part: Part) => bundle[part],
    }
  } catch (cause) {
    if (cause instanceof PassphraseError) {
      throw new Error(
        '口令打不开服务器上的文件：它是用另一个口令加密的——请用你在其他机器上设置的那个口令',
      )
    }
    if (cause instanceof CorruptError && state.local !== undefined) {
      // Half a file, and this computer has synced before: the copy of the last
      // good version kept here is the thing to go on, and the damaged bytes are
      // kept so they can be looked at. Only a body that begins like ours is
      // rebuilt over; anything else might be somebody's work.
      await keepAside(keptDir(paths), 'server-damaged', data).catch(() => undefined)
      // `rebuilt` is what makes the next write happen. The parts here may hash
      // exactly as the last sync left them — nothing about this computer moved —
      // but the bytes on the server are a fragment, so the file has to be
      // written again whatever the hashes say.
      return { ...empty, hashes: state.remote ?? {}, empty: false, rebuilt: true }
    }
    if (cause instanceof CorruptError) {
      // A backup we cannot read is not the same as a file that is not ours, and
      // saying so is what tells the user which of the two buttons to press. The
      // message the reader built says which part gave it away.
      throw new Error(
        `${cause.message}——如果它应该被本机的配置替换，请用「用本机覆盖服务器」`,
      )
    }
    if (cause instanceof NotBackupError) {
      throw new Error(
        `服务器上的文件不是 dsh 同步备份（${REMOTE_FILE}）：如果它应该被本机的配置替换，请用「用本机覆盖服务器」`,
      )
    }
    throw cause
  }
}

/** Seal the merged setup, write it, then write it here. */
async function push(
  engine: Engine,
  state: StoredState,
  snapshot: Snapshot,
  merged: {
    merged: Merged
    applied: Merged
    remote: PartHashes
    version: DavRead['version']
    here: Part[]
    there: Part[]
    saved?: string
  },
): Promise<SyncResult> {
  const { paths, config } = engine
  const bundle: Bundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    created: new Date().toISOString(),
    app: BUNDLE_APP,
    ...(merged.merged as Partial<Bundle>),
  }
  const sealed = await seal(bundle, config.passphrase)

  // What the state held before this write, kept for the blind-write guard. The
  // sum recorded with it is the one this write is about to put on the server, not
  // the one that was there before: the guard is asking, next time, whether the
  // bytes on the server are still the ones it wrote.
  const before = { sum: sum(sealed), local: state.local, remote: state.remote }
  const dav = davOf(config)
  const written = await dav.put(sealed, merged.version.etag ?? '')

  // The parts are written here only after the write to the server succeeded, so a
  // failed upload never leaves this computer holding another computer's setup
  // with nothing to say where its own went.
  const applied = await applyMerged(engine, snapshot, merged.applied)
  const now = hashesOf(partsOf(await take(paths, config), undefined))

  state.server = written
  state.sum = sum(sealed)
  state.remote = hashesOf(bundle)
  state.local = now
  state.blind = written.etag === undefined || written.etag === '' ? { ...before } : undefined
  state.undo = undefined

  const notice: Notice | undefined =
    merged.here.length > 0 || merged.there.length > 0
      ? {
          at: new Date().toISOString(),
          here: merged.here,
          there: merged.there,
          ...(merged.saved === undefined ? {} : { saved: merged.saved }),
        }
      : undefined
  state.notice = notice
  await remember(paths, sealed)

  return {
    here: merged.here,
    there: merged.there,
    ...(merged.saved === undefined ? {} : { saved: merged.saved }),
    pushed: true,
    reloadNeeded: applied.reloadNeeded,
    ...(await pendings(engine, merged.merged.plugins as PluginsPart | undefined)),
  }
}

/**
 * Write the merged parts into the profile's own files.
 *
 * Whatever is about to be replaced is sealed into `sync/` first, so a merge that
 * takes a part away — the mirror of a deletion made on another computer — is
 * always recoverable from this computer. Nothing is written when the file already
 * holds exactly those bytes, so a sync that changed nothing does not touch the
 * profile.
 */
async function applyMerged(
  engine: Engine,
  snapshot: Snapshot,
  applied: Merged,
): Promise<{ reloadNeeded: boolean }> {
  const { paths, config } = engine
  let reloadNeeded = false
  let kept = false

  // The directories are written first so that, when they are written at all, the
  // copy kept for the way back is the one that carries them ({@link keepBefore}).
  // `null` is "the other computer took this part away" — the instruction the other
  // parts obey by deleting a row. Here it means nothing at all on disk: a sync
  // never removes a file from somebody's own directory, so a removed part leaves
  // what is there exactly as it is.
  if (applied.dirs !== undefined && applied.dirs !== null) {
    const part = applied.dirs as DirsPart
    // A directory this run could not read is not written into: what is there now
    // was never read, so replacing it would be writing blind. A directory that is
    // merely absent is not in this set — creating it is what a restore is for. See
    // {@link writeDirs}.
    const skip = new Set(
      snapshot.dirs.problems.filter((problem) => problem.missing !== true).map((problem) => problem.path),
    )
    // Compared with the disk rather than with the configured list, so that a
    // computer which syncs no directories of its own — but is sent somebody's, which
    // is how a restore lands in the same folder — does not seal a copy before a write
    // that changes nothing. The copy is what Undo puts back, so it has to carry the
    // directories whenever they really are about to be written to.
    if (await dirsDiffer(part, skip)) {
      kept = true
      await keepBefore(engine, snapshot, true)
      const wrote = await writeDirs(part, skip)
      if (wrote.changed) reloadNeeded = true
    }
  }

  if (applied.models !== undefined || applied.defaults !== undefined || applied.patch !== undefined) {
    // `null` means "take this away", which is how a removal made on another
    // computer reaches this one. The patch part has no row of its own to remove,
    // so it is emptied instead.
    const next = applyPatch(snapshot.patch, {
      models: applied.models as Merged['models'] as never,
      defaults: applied.defaults as Merged['defaults'] as never,
      ...(applied.patch === null ? { patch: { entries: [] } } : { patch: applied.patch as Merged['patch'] as never }),
    })
    if (next !== snapshot.patch.text) {
      if (!kept) {
        kept = true
        await keepBefore(engine, snapshot)
      }
      if (await writeIfChanged(paths.patchFile, next)) reloadNeeded = true
    }
  }

  if (applied.plugins !== undefined) {
    const next = applyManifest(snapshot.manifest, applied.plugins as never)
    if (next !== snapshot.manifest.text) {
      if (!kept) await keepBefore(engine, snapshot)
      if (await writeIfChanged(paths.packageFile, next)) reloadNeeded = true
    }
  }

  return { reloadNeeded }
}

/**
 * Seal this computer's setup into `sync/before-apply` before a merge writes.
 *
 * `withDirs` is on when the write about to happen touches the extra directories,
 * because that copy is what Undo puts back and a directory left out of it could not
 * be put back. It is off otherwise: a directory tree can run to megabytes, and a
 * copy taken so that one patch row can be undone has no business carrying it.
 */
async function keepBefore(engine: Engine, snapshot: Snapshot, withDirs = false): Promise<string | undefined> {
  try {
    const parts: Merged = withDirs ? partsOf(snapshot, undefined) : { ...snapshot.parts }
    const bundle: Bundle = {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      created: new Date().toISOString(),
      app: BUNDLE_APP,
      ...(parts as Partial<Bundle>),
    }
    const sealed = await seal(bundle, engine.config.passphrase)
    return await keepAside(keptDir(engine.paths), 'before-apply', sealed)
  } catch {
    // Keeping a copy must never be the reason a sync fails.
    return undefined
  }
}

/** Keep both sides of a conflict, so the one that lost is still readable. */
async function keepConflict(
  engine: Engine,
  snapshot: Snapshot,
  remote: RemoteSide,
  withDirs = false,
): Promise<string> {
  const { paths, config } = engine
  const dir = keptDir(paths)
  const parts: Merged = withDirs ? partsOf(snapshot, undefined) : { ...snapshot.parts }
  const ours: Bundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    created: new Date().toISOString(),
    app: BUNDLE_APP,
    ...(parts as Partial<Bundle>),
  }
  await keepAside(dir, 'this-computer', await seal(ours, config.passphrase)).catch(() => undefined)
  if (remote.body !== undefined) {
    await keepAside(dir, 'server', await seal(remote.body, config.passphrase)).catch(() => undefined)
  }
  return dir
}

/**
 * Keep this computer's setup when a sync is about to adopt the server's over it
 * without a baseline to merge against, and name where the copy was left.
 *
 * A first sync is what joining a folder with somebody else's setup in it means:
 * the server wins, and that is right — there is nothing here to weigh against.
 * But a *missing* state file is not the same thing as a first sync, and the two
 * cannot be told apart from the hashes alone: the same empty baseline covers a
 * fresh computer and one whose record of the last sync was deleted, lost or
 * restored from an old backup. What can tell them apart is the cached copy of
 * the server's last file. If it is still here, this computer did sync before,
 * so a merge is exactly what was skipped — and taking the server's answer
 * wholesale is how local work disappears without a word.
 *
 * So the copy is kept and the notice names the folder instead of the sync being
 * refused. Refusing would leave a fresh computer unable to join at all, and the
 * cache is no proof: a stale `sync/` folder left by an older profile is as
 * likely as anything. Keeping the copy is what makes this safe — Restore and
 * Undo already put it back — and saying where it is turns a silent loss into a
 * recoverable one. A join with nothing here to lose keeps nothing and names
 * nothing.
 */
async function keepUnmerged(engine: Engine, snapshot: Snapshot): Promise<string | undefined> {
  const kept = await keepBefore(engine, snapshot, true)
  return kept === undefined ? undefined : keptDir(engine.paths)
}

/**
 * Whether a profile now declares plugins that are not installed here.
 *
 * The part handed in is the MERGED one, not the one this computer happened to
 * hold before the merge: the question the card asks is "will loading this profile
 * now need an install", and a plugin list that just arrived from the server is
 * exactly the case where the answer is yes.
 */
async function pendings(
  engine: Engine,
  declared: PluginsPart | undefined,
): Promise<{ pendingInstall: boolean; pendingNames?: string[] }> {
  if (!engine.config.plugins) return { pendingInstall: false }
  if (declared === undefined) return { pendingInstall: false }
  const installed = await installedPackages(engine.paths)
  const missing = missingPlugins(declared, installed)
  // The names travel with the flag: the card says "these are not installed yet",
  // and a bare true would leave it naming nobody.
  return missing.length === 0 ? { pendingInstall: false } : { pendingInstall: true, pendingNames: missing }
}

// ---------------------------------------------------------------------------
// Restore, upload, undo
// ---------------------------------------------------------------------------

/**
 * Make this computer's setup the server's, whatever changed here.
 *
 * What was here first is sealed into `sync/` with the passphrase, so Undo puts it
 * back. Afterwards the state claims the server already holds what is here, which
 * is true: the next sync pushes it.
 */
export async function restore(engine: Engine): Promise<SyncResult> {
  return guarded(engine, async () => {
    const { paths, config } = engine
    if (!usable(config)) throw new Error('同步还没有配置好：请先填写地址和口令')
    await ensureStateDir(paths)
    const state = await freshState(paths, config)
    const dav = davOf(config)
    const read = await dav.get()
    if (read.notModified || read.data === undefined) {
      if (read.data === undefined) throw new Error('服务器上还没有 dsh 配置：没有可恢复的内容')
    }
    const remote = await openRemote(engine, state, { ...read, notModified: false })
    if (remote.empty) throw new Error('服务器上还没有 dsh 配置：没有可恢复的内容')

    const snapshot = await take(paths, config)
    // What is here *on disk* is what the notice is about, so the directories are
    // hashed without standing in the server's copy for the ones this computer could
    // not read: a folder that is merely absent reads as nothing here, differs from
    // the server's copy, and is therefore named as brought in — which is what a
    // restore that creates it has just done.
    const local = hashesOf(partsOf(snapshot, undefined))
    const here: Part[] = []
    const merged: Merged = {}
    const applied: Merged = {}
    for (const part of PARTS) {
      // A part the configuration turned off is not brought in, however much the
      // server's copy differs: "do not sync this" is the instruction, and a
      // restore that wrote it anyway would be the one action that ignores it.
      if (!syncsPart(config, part)) continue
      const remotePart = remote.part(part)
      if (remotePart !== undefined) {
        merged[part] = remotePart
        applied[part] = remotePart
      }
      // Restore does not weigh who changed what: every part that differs is
      // brought in, which is the whole point of the action.
      if (local[part] !== remote.hashes[part]) here.push(part)
    }

    const kept = await keepBefore(engine, snapshot, true)
    const written = await applyMerged(engine, snapshot, applied)
    state.undo = kept ?? ''
    state.remote = remote.hashes
    state.local = hashesOf(partsOf(await take(paths, config), undefined))
    state.sum = read.data === undefined ? state.sum : sum(read.data)
    state.server = read.version
    state.blind = undefined
    state.last = new Date().toISOString()
    state.error = ''
    state.notice = { at: new Date().toISOString(), here, there: [], ...(kept === undefined ? {} : { saved: keptDir(paths) }), restored: true }
    if (read.data !== undefined) await remember(paths, read.data)
    await saveState(paths, state)
    return {
      here,
      there: [],
      ...(kept === undefined ? {} : { saved: keptDir(paths) }),
      pushed: false,
      reloadNeeded: written.reloadNeeded,
      ...(await pendings(engine, applied.plugins as PluginsPart | undefined)),
    }
  })
}

/**
 * Write over a file on the server that is not a backup of ours.
 *
 * A file that opens as ours, or that was sealed with another passphrase, is never
 * written over: the first is what Sync now merges with, and the second is
 * somebody's backup that this computer has no business replacing. Whatever the
 * server held is kept under `sync/` before anything is written.
 */
export async function upload(engine: Engine): Promise<SyncResult> {
  return guarded(engine, async () => {
    const { paths, config } = engine
    if (!usable(config)) throw new Error('同步还没有配置好：请先填写地址和口令')
    await ensureStateDir(paths)
    const state = await freshState(paths, config)
    const dav = davOf(config)
    const read = await dav.get()

    if (read.data !== undefined) {
      let readable = true
      try {
        await open(read.data, config.passphrase)
      } catch (cause) {
        if (cause instanceof PassphraseError) {
          throw new Error(
            '服务器上的文件是用另一个口令加密的，所以没有覆盖它：请用你在其他机器上设置的那个口令',
          )
        }
        if (cause instanceof NotBackupError || cause instanceof CorruptError) readable = false
        else throw cause
      }
      if (readable) {
        throw new Error(
          '服务器上的文件是本机能打开的 dsh 同步备份：请改用「立即同步」和它合并，这次没有覆盖任何东西',
        )
      }
      await keepAside(keptDir(paths), 'server-replaced', read.data)
    }

    const snapshot = await take(paths, config)
    const result = await push(engine, state, snapshot, {
      merged: { ...partsOf(snapshot, undefined) },
      applied: {},
      remote: {},
      version: read.version,
      here: [],
      there: [],
    })
    state.last = new Date().toISOString()
    state.error = ''
    await saveState(paths, state)
    return result
  })
}

/** Put back the setup the last restore replaced. */
export async function undo(engine: Engine): Promise<SyncResult> {
  return guarded(engine, async () => {
    const { paths, config } = engine
    const state = await loadState(paths)
    if (state.key !== stateKey(config) || state.undo === undefined || state.undo === '') {
      throw new Error('没有可撤销的恢复')
    }
    let data: Buffer
    try {
      data = await readFile(state.undo)
    } catch {
      throw new Error('恢复之前留下的那份副本已经不在了，没有东西可以放回去')
    }
    const bundle = (await open(new Uint8Array(data), config.passphrase)) as Bundle
    const snapshot = await take(paths, config)
    const merged: Merged = {}
    const applied: Merged = {}
    const back: Part[] = []
    for (const part of PARTS) {
      // Undo is a write to this computer's files like any other, so a part the
      // configuration turned off is left alone here too. The copy it came from
      // keeps the whole setup either way.
      if (!syncsPart(config, part)) continue
      const kept = bundle[part]
      if (kept === undefined) continue
      merged[part] = kept
      applied[part] = kept
      back.push(part)
    }
    const written = await applyMerged(engine, snapshot, applied)
    state.undo = ''
    state.notice = undefined
    await saveState(paths, state)
    return {
      here: back,
      there: [],
      pushed: false,
      reloadNeeded: written.reloadNeeded,
      ...(await pendings(engine, merged.plugins as PluginsPart | undefined)),
    }
  })
}

// ---------------------------------------------------------------------------
// Status, dismiss, off
// ---------------------------------------------------------------------------

/**
 * What the card shows: the configuration without its secrets, where the files
 * are, and how each part stands against the last sync.
 *
 * `localChanged` and `remoteChanged` are answered from the stored hashes alone,
 * so opening the card costs one file read and no request to the server. A part
 * the configuration does not carry is reported as it stands but never as
 * changed, since nothing about it would move.
 */
export async function status(engine: Engine): Promise<StatusResult> {
  const { paths, config } = engine
  const state = await loadState(paths)
  const fresh = state.key === stateKey(config)
  const snapshot = await take(paths, config).catch(() => undefined)
  const local: PartHashes = snapshot === undefined ? {} : hashesOf(partsOf(snapshot, undefined))
  const parts: PartView[] = []
  const known = fresh ? state.local : undefined
  const knownRemote = fresh ? state.remote : undefined
  const first = known === undefined
  for (const part of PARTS) {
    // What the server holds now cannot be known without asking it, and asking it
    // on every card open is a request per glance. So these two flags answer for
    // the last sync, not for now, and they answer about different things:
    // `localChanged` is whether this computer's file has moved since that sync,
    // and `remoteChanged` is whether the two sides were left out of step — which
    // is what the next merge will have to reconcile. Neither is a statement that
    // the server moved; {@link preview} asks the server and answers for real.
    //
    // The two are deliberately independent rather than one flag read twice. After
    // a good sync the recorded sides agree, so the older reading
    // (`here !== there`, i.e. "this file differs from the server") said the same
    // thing as `localChanged` and lit both, and the card then told the user that
    // both sides had changed when only this one had.
    const here = local[part] ?? null
    const there = knownRemote?.[part] ?? null
    const was = known?.[part] ?? null
    parts.push({
      part,
      local: here,
      remote: there,
      localChanged: !first && here !== was,
      remoteChanged: !first && was !== there,
      synced: syncsPart(config, part),
    })
  }
  const plugins = snapshot?.parts.plugins
  const missing =
    config.plugins && plugins !== undefined
      ? missingPlugins(plugins, await installedPackages(paths).catch(() => []))
      : []
  // A failure is reported for the configuration that failed. `fresh` covers the
  // ordinary case; `errorKey` covers the one where the failure itself changed the
  // key — a wrong passphrase — which is exactly when the card most needs to say so.
  const errorApplies = fresh || (state.errorKey !== undefined && state.errorKey === stateKey(config))
  return {
    configured: usable(config),
    config: viewOf(config),
    paths: {
      profileDir: paths.profileDir,
      stateDir: paths.stateDir,
      patchFile: paths.patchFile,
      packageFile: paths.packageFile,
    },
    ...(fresh && state.last !== undefined && state.last !== '' ? { last: state.last } : {}),
    error: errorApplies && typeof state.error === 'string' ? state.error : '',
    ...(fresh && state.notice !== undefined ? { notice: state.notice } : {}),
    parts,
    pendingInstall: missing.length > 0,
    ...(missing.length > 0 ? { pendingNames: missing } : {}),
    // A directory that could not be read is said here rather than kept quiet: it
    // is the one thing about this feature the person has to act on.
    ...(snapshot === undefined || snapshot.dirs.problems.length === 0
      ? {}
      : { dirProblems: snapshot.dirs.problems }),
    undoable: fresh && state.undo !== undefined && state.undo !== '',
  }
}

/** The card's "dismiss": forget the notice, and nothing else. */
export async function dismiss(engine: Engine): Promise<void> {
  const state = await loadState(engine.paths)
  if (state.key !== stateKey(engine.config)) return
  state.notice = undefined
  await saveState(engine.paths, state)
}

/**
 * Turn sync off, keeping what is known about the server.
 *
 * The state is kept deliberately: turning sync back on to the same address must
 * not read as joining a folder for the first time, which would take the server's
 * older setup over this computer's newer one.
 */
export async function turnOff(engine: Engine): Promise<void> {
  const config = { ...engine.config, url: '', password: '' }
  await saveConfig(engine.paths, config)
  // A password held in memory rather than written down is still a password this
  // host would send, and turning sync off is the way to clear one.
  releasePassword(engine.paths)
}

/**
 * The client one configuration reaches: its address, its account, and the extra
 * headers the card configured. Parsed once here rather than at every call, so a
 * malformed configured line is refused before the first request goes out.
 */
function davOf(config: SyncConfig): Dav {
  return new Dav({
    url: config.url,
    user: config.user,
    password: config.password,
    headers: parseHeaders(config.headers),
  })
}

/** The configuration as the card sees it: never a secret, only whether one is set. */
export function viewOf(config: SyncConfig): ConfigView {
  return {
    url: config.url,
    user: config.user,
    passwordSet: config.password !== '',
    passphraseSet: config.passphrase !== '',
    autoEvery: config.autoEvery,
    models: config.models,
    defaults: config.defaults,
    plugins: config.plugins,
    patch: config.patch,
    dirs: [...config.dirs],
    dirsEnabled: config.dirsEnabled,
    rememberPassword: config.rememberPassword,
    headers: config.headers,
  }
}

// ---------------------------------------------------------------------------
// Check and preview
// ---------------------------------------------------------------------------

/** Reach the server and say what is there, without changing anything. */
export async function check(engine: Engine): Promise<CheckResult> {
  const { config } = engine
  if (normaliseUrl(config.url) === '') throw new Error('请先填写同步地址')
  const dav = davOf(config)
  try {
    await dav.check()
  } catch (cause) {
    if (cause instanceof LoginError || cause instanceof RateLimitedError) {
      return { ok: false, message: cause.message, hasBackup: false }
    }
    throw cause
  }
  const found = await dav.stat()
  if (!found.exists) {
    return {
      ok: true,
      message: '服务器有响应，上面还没有你的备份：第一次同步会写一份上去',
      hasBackup: false,
    }
  }
  const read = await dav.get()
  let created: string | undefined
  if (read.data !== undefined) {
    try {
      const bundle = (await open(read.data, config.passphrase)) as Bundle
      if (typeof bundle.created === 'string') created = bundle.created
    } catch (cause) {
      if (cause instanceof PassphraseError) {
        return {
          ok: false,
          message:
            '服务器有响应，上面也有备份，但口令打不开它——它是用另一个口令加密的',
          hasBackup: true,
          ...(found.size === undefined ? {} : { size: found.size }),
        }
      }
    }
  }
  return {
    ok: true,
    message: '服务器有响应，账号可以写入这个目录，你的备份就在上面',
    hasBackup: true,
    ...(found.size === undefined ? {} : { size: found.size }),
    ...(created === undefined ? {} : { created }),
  }
}

/** What one sync would do, decided the same way but writing nothing anywhere. */
export async function preview(engine: Engine): Promise<PreviewResult> {
  const { paths, config } = engine
  if (!usable(config)) throw new Error('同步还没有配置好：请先填写地址和口令')
  const state = await freshState(paths, config)
  const dav = davOf(config)
  const read = await dav.get(state.server)
  const remote = await openRemote(engine, state, read)
  const snapshot = await take(paths, config)
  const local = hashesOf(partsOf(snapshot, remote.part('dirs') as DirsPart | undefined))
  const first = state.local === undefined
  const changes: PreviewChange[] = []
  for (const part of PARTS) {
    if (!syncsPart(config, part)) continue
    // The same test the sync itself uses, so what the card promises and what the
    // merge does cannot drift apart.
    const changedHere = !first && local[part] !== state.local?.[part]
    const changedThere = first || remote.hashes[part] !== state.remote?.[part]
    if (!changedHere && !changedThere) continue
    if (changedHere && changedThere) {
      const serverAt = Date.parse(remote.created)
      const ours = localChangedAt(snapshot, part)
      changes.push({ part, take: !Number.isFinite(serverAt) || ours >= serverAt ? 'newer-local' : 'newer-remote' })
      continue
    }
    changes.push({ part, take: changedHere ? 'local' : 'remote' })
  }
  return { changes }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Read this computer's setup and the files it came from, in one pass. */
export async function take(paths: ResolvedPaths, config: SyncConfig): Promise<Snapshot> {
  const patch = await readPatch(paths)
  const manifest = await readManifest(paths)
  // Switched off, the directories are not walked at all: reading them is the one
  // part of a snapshot that can cost a great deal, and a part this configuration
  // does not carry has nothing to say. An empty read still tells the merge there is
  // nothing here to compare, which is exactly true.
  const dirs = await readDirs(config.dirsEnabled ? config.dirs : [])
  return { patch, manifest, parts: collect(patch, manifest), dirs }
}

/** Per-part hashes of a setup; a part that is not there has none. */
export function hashesOf(parts: Partial<Record<Part, unknown>> | Bundle): PartHashes {
  const source = parts as Record<string, unknown>
  const out: PartHashes = {}
  for (const part of PARTS) {
    const value = source[part]
    if (value !== undefined) out[part] = hashJson(value)
  }
  return out
}

/** Whether two sets of part hashes describe the same setup. */
export function sameHashes(a: PartHashes, b: PartHashes | undefined): boolean {
  if (b === undefined) return false
  for (const part of PARTS) {
    if (a[part] !== b[part]) return false
  }
  return true
}

/** When this computer last changed a part, in milliseconds, for the tie-break. */
export function localChangedAt(snapshot: Snapshot, part: Part): number {
  if (part === 'plugins') return snapshot.manifest.mtimeMs
  // The extra directories have no file of their own to point at, so the newest
  // file inside any of them stands for the whole part.
  if (part === 'dirs') return snapshot.dirs.mtimeMs
  return snapshot.patch.mtimeMs
}

/** The top-level packages present in the profile's node_modules. */
export async function installedPackages(paths: ResolvedPaths): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const root = join(paths.profileDir, 'node_modules')
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch (cause) {
    if (isMissing(cause)) return []
    throw cause
  }
  const names: string[] = []
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      const scoped = await readdir(join(root, entry)).catch(() => [] as string[])
      for (const inner of scoped) names.push(`${entry}/${inner}`)
      continue
    }
    names.push(entry)
  }
  return names
}

/** The profile directory a set of paths names, for a caller that only has a config. */
export function pathsOf(profileDir: string): ResolvedPaths {
  return resolvePaths(profileDir)
}

export { loadConfig, sameAccount, saveConfig, usable, missingPlugins }
export type { PreviewResult }
