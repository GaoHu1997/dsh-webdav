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

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import {
  BACKUP_EXT,
  BUNDLE_APP,
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  PARTS,
  REMOTE_FILE,
  type Bundle,
  type CheckResult,
  type ConfigView,
  type DirsPart,
  type Dismissed,
  type DismissTarget,
  type ExportBody,
  type ExportResult,
  type ImportBody,
  type ImportResult,
  type Notice,
  type Part,
  type PartHashes,
  type PartView,
  type PatchPart,
  type KeyProblem,
  type KeysPart,
  type McpPart,
  type PluginsPart,
  type PreviewChange,
  type PreviewResult,
  type SkillsPart,
  type StatusResult,
  type StoredState,
  type SyncConfig,
  type SyncResult,
} from './wire.js'
import { CorruptError, NotBackupError, PassphraseError, hashJson, open, seal, sum } from './crypto.js'
import { Dav, LoginError, RateLimitedError, parseHeaders, type DavRead } from './dav.js'
import { dirsDiffer, dirsPartOf, readDirs, writeDirs, type DirsRead } from './dirs.js'
import { readSkills, skillsDiffer, skillsPartOf, writeSkills, type SkillsRead } from './skills.js'
import {
  applyManifest,
  applyPatch,
  collect,
  isMissing,
  isModelOverride,
  joinMcp,
  keepAside,
  message,
  missingPlugins,
  modelsIdentity,
  modelsLayer,
  readHomePatch,
  readManifest,
  readPatch,
  sameJson,
  splitMcp,
  withoutModels,
  writeIfChanged,
  type Collected,
  type ManifestFile,
  type PatchFile,
} from './store.js'
import {
  ensureStateDir,
  keptDir,
  loadConfig,
  loadState,
  normaliseUrl,
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
import { applyKeys, dirRefs, readKeys, unionKeys, type KeysPort } from './keys.js'

/** The parts of one setup, as values, keyed by part name. */
type Merged = Partial<Record<Part, unknown>>

/** One read of this computer's setup, with the files it came from. */
interface Snapshot {
  patch: PatchFile
  /**
   * The file whose model row DSH actually applies, which is not always the
   * profile patch: the home patch is layered after it and replaces `config`
   * wholesale, so a catalog written there wins over the one in the profile.
   * See `docs/decisions/0071-sync-the-catalog-where-it-takes-effect.md`.
   */
  modelsPatch: PatchFile
  /** Where {@link modelsPatch} lives; `paths.patchFile` unless it is the home patch. */
  modelsFile: string
  manifest: ManifestFile
  /** The parts that come out of the profile's own two files, plus the keys. */
  parts: Collected
  /** The extra directories, walked from disk, with whatever could not be read. */
  dirs: DirsRead
  /** The skill folders, walked from disk, with whatever could not be read. */
  skills: SkillsRead
  /**
   * Credential references this read could not resolve, with the reason.
   *
   * Kept on the snapshot rather than inside `parts` for the same reason the
   * directories keep theirs beside the part: a store that cannot be read must not
   * travel as "this computer has no keys". See {@link readKeys}.
   */
  keysProblems: KeyProblem[]
}

/**
 * This computer's whole setup, as parts.
 *
 * The profile parts are read once, and the keys with them; the extra directories
 * and the skill folders have to be walked, so they arrive separately and are put
 * back together here. `carried` is the server's `dirs` and `skills` parts, and it
 * is used for the entries this computer could not read — see {@link dirsPartOf}
 * and {@link skillsPartOf} for why carrying those beats reading them as empty.
 */
function partsOf(snapshot: Snapshot, carried?: { dirs?: DirsPart; skills?: SkillsPart } | undefined): Merged {
  const dirs = dirsPartOf(snapshot.dirs, carried?.dirs)
  const skills = skillsPartOf(snapshot.skills, carried?.skills)
  // Nothing named and nothing carried: a part is left out entirely rather than
  // sent as an empty one, so a computer that has none of them can never be the
  // one that empties the part for the computers that do.
  return {
    ...snapshot.parts,
    ...(dirs === undefined ? {} : { dirs }),
    ...(skills === undefined ? {} : { skills }),
  }
}

/**
 * The server's copy of the two parts that live outside the profile's own files:
 * the extra directories and the skill folders. Both are carried past entries this
 * computer could not read, which is why the merge asks the remote for them.
 */
function carriedOf(remote: RemoteSide): { dirs?: DirsPart; skills?: SkillsPart } {
  const dirs = remote.part('dirs') as DirsPart | undefined
  const skills = remote.part('skills') as SkillsPart | undefined
  return {
    ...(dirs === undefined ? {} : { dirs }),
    ...(skills === undefined ? {} : { skills }),
  }
}

/** Everything a sync needs, resolved once. */
export interface Engine {
  paths: ResolvedPaths
  config: SyncConfig
  /**
   * The host's credential store, absent on a host without one.
   *
   * Carried on the engine for the same reason the paths are: it is the one thing
   * a call needs that no configuration can say. Absent is a working state — the
   * `keys` part then has nothing to read and nothing to write, and says so.
   */
  credentials?: KeysPort | undefined
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

/** The engine for a profile directory, a configuration, and the host's credential store. */
export function engineFor(paths: ResolvedPaths, config: SyncConfig, credentials?: KeysPort | undefined): Engine {
  return { paths, config, credentials }
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
    const at = new Date().toISOString()
    state.last = at
    state.error = ''
    // `here` and `there` name the parts that moved, and `pushed` says the sealed
    // file went up: any of the three means this attempt moved bytes. An attempt
    // that only looked leaves `moved` where it was, which is what tells a check
    // apart from a sync on the card. See docs/decisions/0039-the-card-says-check-and-sync-apart.md.
    if (outcome.pushed || outcome.here.length > 0 || outcome.there.length > 0) state.moved = at
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

/**
 * What one part of the merge comes down to.
 *
 * The sync and the preview ask the same question of every part — which copy is
 * the answer? — and this is that question, asked once. The two callers differ
 * only in what they do with the answer: {@link syncOnce} writes it out and names
 * the part in its result, {@link preview} turns it into the sentence the card
 * shows. A second copy of this reasoning is what once let the card promise a
 * pull where the sync would push; see
 * `docs/decisions/0076-audit-fixes-fourth-pass.md`.
 */
interface PartMove {
  /**
   * - `off`: switched off or unreadable here, so the server's copy rides through
   * - `same`: both sides moved, and to the same content — nothing to settle
   * - `mine`: this computer's copy is the answer
   * - `theirs`: the server's copy is the answer
   * - `drop`: the server's absence is the answer; the part is taken away here
   * - `push-back`: the server dropped a folder part this computer still carries
   * - `keep-off`: this computer stopped carrying a folder part the server has
   * - `carry-local`, `carry-remote`: neither side moved, so the copy that is
   *   there rides through — and is written when this computer lacks it
   * - `union`: both sides moved, and the part is a set — the two copies are
   *   combined, written here and pushed up
   * - `nothing`: neither side has anything to say about this part
   */
  take:
    | 'off'
    | 'same'
    | 'mine'
    | 'theirs'
    | 'union'
    | 'drop'
    | 'push-back'
    | 'keep-off'
    | 'carry-local'
    | 'carry-remote'
    | 'nothing'
  /** True when both sides moved, to different content, and the newer one won. */
  conflict: boolean
  /**
   * For `union`: the combined part — the copy that is written here and pushed
   * up. Absent for every other take, which name a side rather than a value.
   */
  merged?: unknown
}

/** Everything {@link moveFor} may look at when it answers for one part. */
interface MoveInput {
  part: Part
  config: SyncConfig
  /** True when nothing has ever been synced, so there is no baseline. */
  first: boolean
  state: StoredState
  snapshot: Snapshot
  /** Hash of each part as this computer has it; absent when it has none. */
  local: PartHashes
  /** The same parts as values, for the write that may follow. */
  localParts: Merged
  /** Hash of the part as the server has it, `undefined` when it has none. */
  remoteHash: string | undefined
  /** The server's copy, `undefined` when it carries none. */
  remotePart: unknown
  /** The stamp the server wrote into the file, for the newer-copy comparison. */
  remoteCreated: string
}

function moveFor(input: MoveInput): PartMove {
  const { part, config, first, state, snapshot, local, localParts, remoteHash, remotePart } = input
  const remoteHas = remoteHash !== undefined

  // A part this run could not read at all is deferred rather than merged: the
  // server's copy is carried through untouched and nothing about it is decided
  // here. Keys defer as a whole — a credential store that cannot be read is
  // unknown, not a deletion — and the skill folders defer when even their root
  // could not be listed. One unreadable folder inside the root is that folder's
  // problem alone and is carried within the part, the way an unreadable
  // directory is.
  const unreadableWhole =
    (part === 'keys' && snapshot.keysProblems.length > 0)
    || (part === 'skills' && snapshot.skills.problems.some((problem) => problem.name === ''))
  if (!syncsPart(config, part) || unreadableWhole) return { take: 'off', conflict: false }

  // A side moved when its hash for the part is not the one carried over from the
  // last sync — not merely when its presence changed. Comparing presence would
  // read an edit made only on the other computer as "unchanged" and quietly keep
  // this computer's older copy.
  const missingKeyBaseline = !first && state.keysBaseline !== true && part === 'keys'
  const changedHere = !first && !missingKeyBaseline && local[part] !== state.local?.[part]
  const changedThere = first || remoteHash !== state.remote?.[part]
  // A part the other computer took away is taken away here too — but never the
  // plugin list, which is what loads the shell, and never on a first sync, where
  // an absent part only means this computer has nothing to compare.
  const removable = !first && part !== 'plugins'

  if (changedHere && changedThere) {
    // The same content on both sides is nothing to settle. A state recorded
    // under another naming of these parts — the MCP rows were lifted out of the
    // patch part in `docs/decisions/0075-mcp-and-skills-parts.md` — reads as both
    // sides having moved at once, and one edit made on both computers reads that
    // way too. The content is the truth: carry it and stop.
    //
    // Both sides must *have* the part before there is content to compare: a
    // computer running a version that does not know this part writes the file
    // without it, and hashing nothing throws. Presence first, then content.
    if (local[part] !== undefined && remoteHas && sameJson(localParts[part], remotePart)) {
      return { take: 'same', conflict: false }
    }
    // The keys are a set of named secrets, not one document, and the two
    // computers usually moved them for different providers — each one stores
    // the key it was just handed through the Models page, which touches no file
    // a hash can watch. Taking either copy whole therefore dropped the other
    // side's keys out of the file, and the computer that lost them found its
    // own provider warning that the variable is missing with nothing on the
    // card to say a merge had happened. The union keeps both; a reference both
    // sides hold keeps this computer's value, which is the answer the
    // newer-copy comparison below used to give for the part as a whole.
    //
    // A union is not a conflict: nothing was lost, so there is no copy to keep
    // aside and no sentence about one side winning.
    if (part === 'keys') {
      const merged = unionKeys(localParts.keys as KeysPart | undefined, remotePart)
      // Nothing on the other side this one lacks: its copy arrives here.
      if (sameJson(merged, localParts.keys)) return { take: 'mine', conflict: false }
      return { take: 'union', conflict: false, merged }
    }
    // Both sides moved. The newer of the two wins, compared against the stamp
    // the server wrote into the file.
    const serverAt = Date.parse(input.remoteCreated)
    const ours = localChangedAt(snapshot, part)
    if (!Number.isFinite(serverAt) || ours >= serverAt) {
      return local[part] === undefined ? { take: 'nothing', conflict: true } : { take: 'mine', conflict: true }
    }
    if (remoteHas) return { take: 'theirs', conflict: true }
    // The other computer removed the part and its file is the newer one, so the
    // removal is the newer answer.
    return removable ? { take: 'drop', conflict: true } : { take: 'nothing', conflict: true }
  }

  if (changedThere) {
    // Only the server moved. Its copy is brought in — including its absence,
    // which is how a part removed on another computer is removed here.
    if (remoteHas) return { take: 'theirs', conflict: false }
    if ((part === 'dirs' || part === 'skills') && local[part] !== undefined) {
      // The one removal this computer does not take. Its own directories are
      // still named here and its skill folders are still on this disk, and these
      // parts do nothing but say which trees travel: taking them away would
      // leave those files unsynced for no gain — or, when the server merely
      // dropped the field, delete folders somebody made by hand for a reason
      // known only here. The copy here is what goes back up.
      return { take: 'push-back', conflict: false }
    }
    return removable ? { take: 'drop', conflict: false } : { take: 'nothing', conflict: false }
  }

  if (changedHere) {
    // Only this computer moved: the part goes up.
    if (local[part] !== undefined) return { take: 'mine', conflict: false }
    if ((part === 'dirs' || part === 'skills') && remoteHas) {
      // This computer stopped carrying these trees — its list of directories was
      // emptied, or its skill folders were taken off this disk. That means "stop
      // syncing these on this computer", not "everybody delete them": the part
      // is carried through as the server has it, so the computers that still
      // carry a tree keep syncing it between themselves and no file anywhere is
      // removed for it. Nothing is applied — the folders deleted here stay
      // deleted here.
      return { take: 'keep-off', conflict: false }
    }
    return { take: 'nothing', conflict: false }
  }

  // Neither side moved. This computer's copy is taken when it has one, so a part
  // that is present on only one side is never dropped by accident.
  if (local[part] !== undefined) return { take: 'carry-local', conflict: false }
  return remoteHas ? { take: 'carry-remote', conflict: false } : { take: 'nothing', conflict: false }
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

  // A home layer that only shadows the synced catalog is handed back to the
  // profile before anything is measured, so this sync reads the same catalog the
  // last one recorded and a repair cannot look like an edit here.
  const repaired = await reconcileLayers(engine)
  const snapshot = await take(paths, config, engine.credentials)
  if (snapshot.keysProblems.length === 0 && state.local?.keys !== undefined) {
    // Older state files predate the explicit marker; an existing keys hash is
    // already a trustworthy baseline, even before this run measures it again.
    state.keysBaseline = true
  }
  let remote = await openRemote(engine, state, read)

  const first = state.local === undefined
  // A directory or a skill folder could not be read this run: its part stands in
  // for the server's copy of it, and the server's copy cannot be known from a
  // `notModified` answer — so the comparison below is made without it and comes
  // out false, which takes this sync the long way round and reads the file. That
  // is the right price for not confusing "could not measure" with "measured, and
  // it is empty".
  if (
    remote.notModified
    && sameHashes(hashesOf(partsOf(snapshot, carriedOf(remote))), state.local)
    && !force
  ) {
    // Neither side moved: the last sync is still the state of the world. A layer
    // repair still happened, and the host has to be told to read the catalog from
    // where it now lives, or the old order stays on screen until a restart.
    return {
      here: [], there: [], pushed: false, reloadNeeded: repaired,
      ...keyProblems(snapshot.keysProblems),
      ...(await pendings(engine, snapshot.parts.plugins)),
    }
  }
  if (remote.notModified) {
    // The server said the file is the one last read, which was worth knowing for
    // the check above — but something here moved, so the file's own parts are
    // needed to merge against and it is read again, this time in full.
    remote = await openRemote(engine, state, await dav.get())
  }

  const localParts = partsOf(snapshot, carriedOf(remote))
  // A failed credential read is unknown, not a deletion or a partial replacement.
  // Defer this part while the other parts sync, carrying the server's copy below.
  if (snapshot.keysProblems.length > 0) delete localParts.keys
  const local = hashesOf(localParts)

  // The server holds no file of ours. This computer's setup becomes the first
  // version, which is what joining an empty folder means.
  if (remote.empty) {
    const pushed = await push(engine, state, snapshot, {
      merged: { ...localParts },
      applied: { ...localParts },
      remote: remote.hashes,
      version: remote.version,
      here: [],
      there: [],
    })
    return repaired ? { ...pushed, reloadNeeded: true } : pushed
  }

  const merged: Merged = {}
  const applied: Merged = {}
  const here: Part[] = []
  const there: Part[] = []
  let conflicted = false

  for (const part of PARTS) {
    const remoteHas = remote.hashes[part] !== undefined
    const remotePart = (): unknown => remote.part(part)
    const move = moveFor({
      part,
      config,
      first,
      state,
      snapshot,
      local,
      localParts,
      remoteHash: remote.hashes[part],
      remotePart: remotePart(),
      remoteCreated: remote.created,
    })

    switch (move.take) {
      case 'off':
        // Disabled or unreadable: carry the server's copy untouched. In particular,
        // a missing/locked credential service must not look like local key deletion
        // and erase the keys already uploaded by a successful manual sync.
        if (remoteHas) merged[part] = remotePart()
        break
      case 'same':
        merged[part] = localParts[part]
        break
      case 'mine':
      case 'push-back':
        // The copy here is the answer, so it goes up as well as into the write.
        merged[part] = localParts[part]
        applied[part] = localParts[part]
        there.push(part)
        break
      case 'theirs':
        // `null` never reaches here: `theirs` is only ever the server's content.
        merged[part] = remotePart()
        applied[part] = remotePart()
        here.push(part)
        break
      case 'union':
        // Both sides moved and the part is a set: the combined copy goes up and
        // is written here. {@link applyKeys} stores only a reference this
        // computer lacks or holds a different value under, so the local half of
        // the union is a no-op and the other computer's keys land.
        merged[part] = move.merged
        applied[part] = move.merged
        there.push(part)
        break
      case 'drop':
        // `null` is the instruction to take the part away; leaving it `undefined`
        // would mean "do not touch", which is how a part stays that should have gone.
        applied[part] = null
        here.push(part)
        break
      case 'keep-off':
        // Nothing is applied — the folders deleted here stay deleted here.
        merged[part] = remotePart()
        break
      case 'carry-local':
        merged[part] = localParts[part]
        applied[part] = localParts[part]
        break
      case 'carry-remote':
        merged[part] = remotePart()
        // A computer that names no directories leaves its disk alone here: writing
        // the server's list back would put files into a folder the user has just
        // taken off that list. Restore is the action that lands in such a folder,
        // and it says so on the card; an ordinary sync has nothing to write.
        if (part !== 'dirs' || config.dirs.length > 0) applied[part] = remotePart()
        break
      default:
        break
    }
    if (move.conflict) conflicted = true
  }

  let saved: string | undefined
  if (conflicted) {
    saved = await keepConflict(engine, snapshot, remote,
      here.includes('dirs') || there.includes('dirs') || here.includes('skills') || there.includes('skills'))
  }
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
    // Read back rather than assume: a directory whose file was just written — or
    // removed — has to be hashed as it now is, or the next sync would see an edit
    // that this one made itself and call it a conflict. Keep the key baselines if
    // this read could not measure them, so recovery still sees pending edits.
    const after = await take(paths, config, engine.credentials)
    recordHashes(state, hashesOf(partsOf(after, undefined)), remote.hashes,
      snapshot.keysProblems.length === 0 && after.keysProblems.length === 0)
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
      reloadNeeded: written.reloadNeeded || repaired,
      ...keyProblems([...snapshot.keysProblems, ...written.keysProblems]),
      ...keysStored(written.keysWritten),
      ...(await pendings(engine, applied.plugins as PluginsPart | undefined)),
    }
  }

  const pushed = await push(engine, state, snapshot, {
    merged,
    applied,
    remote: remote.hashes,
    version: remote.version,
    here,
    there,
    ...(saved === undefined ? {} : { saved }),
  })
  return repaired ? { ...pushed, reloadNeeded: true } : pushed
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
 * Absent parts are fine: a bundle may carry any of them. The `mcp` rows ride in
 * the `patch` field and are checked apart from the rest of that field's rows, so
 * a bundle whose MCP rows alone went strange names that part in the error.
 */
function unreadablePart(bundle: Bundle): Part | undefined {
  const isObject = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value)
  const entriesOf = (value: unknown): boolean =>
    isObject(value)
    && Array.isArray((value as Record<string, unknown>).entries)
    && ((value as Record<string, unknown>).entries as unknown[]).every((one) => isObject(one) || typeof one === 'string')
  // The wire's `patch` field carries the patch rows and the MCP rows both (see
  // docs/decisions/0075-mcp-and-skills-parts.md), so it has to read as entry
  // rows before the two are parted out of it — and that is the very shape both
  // of them need afterwards.
  if (bundle.patch !== undefined && !entriesOf(bundle.patch)) return 'patch'
  const parts = splitParts(bundle)
  for (const part of PARTS) {
    const value: unknown = parts[part]
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
    if (part === 'models') {
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
    if (part === 'keys') {
      // Ref names and their values, both strings: anything else is a file this
      // plugin did not write, and reading it as empty would be a lie about what
      // this computer holds.
      const refs = record.refs
      if (!isObject(refs)) return part
      if (!Object.entries(refs as Record<string, unknown>).every(([ref, value]) => ref !== '' && typeof value === 'string')) return part
      continue
    }
    if (part === 'skills') {
      // Skill folders, each with its name under the root and its files: anything
      // else is not a part this plugin wrote, and an empty list is a setup with
      // no skills rather than a part that cannot be read.
      if (!Array.isArray(record.skills)) return part
      const readable = (one: unknown): boolean => {
        if (!isObject(one)) return false
        const skill = one as Record<string, unknown>
        if (typeof skill.name !== 'string' || !Array.isArray(skill.files)) return false
        return skill.files.every((file) => {
          if (!isObject(file)) return false
          const inner = file as Record<string, unknown>
          return typeof inner.path === 'string' && typeof inner.data === 'string'
        })
      }
      if (!record.skills.every(readable)) return part
      continue
    }
    // The remaining parts are entry lists: the patch file's own rows, and the MCP
    // rows lifted out of them — the same shape twice.
    if (!entriesOf(value)) return part
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

  // A server with no file is a server with no file. The cached copy holds this
  // computer's own last upload, so standing it in for a file that was deleted
  // there made every part look unchanged: `pushNeeded` stayed false for ever
  // and the card kept saying 已是最新 while the backup was gone
  // (docs/decisions/0078-a-deleted-backup-is-pushed-again.md).
  const data = read.data
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
    // The parts are the lifted view of the fields — `mcp` apart from `patch`, as
    // every hash and every merge from here on expects them.
    const parts = splitParts(bundle)
    return {
      hashes: hashesOf(parts),
      body: bundle,
      created: typeof bundle.created === 'string' ? bundle.created : new Date(0).toISOString(),
      version: read.version,
      notModified: false,
      empty: false,
      part: (part: Part) => parts[part],
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
  // The fields, as a bundle: `bundleParts` rejoins the `mcp` rows into the `patch`
  // field, so this file is the same one older versions have always written.
  const bundle: Bundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    created: new Date().toISOString(),
    app: BUNDLE_APP,
    ...bundleParts(merged.merged),
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
  const after = await take(paths, config, engine.credentials)
  const now = hashesOf(partsOf(after, undefined))

  state.server = written
  state.sum = sum(sealed)
  // The remote side is recorded as the parts the next read will lift back out of
  // these bytes, so the two are always the same view and a run never sees its own
  // push as somebody else's edit.
  recordHashes(state, now, hashesOf(splitParts(bundle)),
    snapshot.keysProblems.length === 0 && after.keysProblems.length === 0)
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
    ...keyProblems([...snapshot.keysProblems, ...applied.keysProblems]),
    ...keysStored(applied.keysWritten),
    ...(await pendings(engine, merged.merged.plugins as PluginsPart | undefined)),
  }
}

/**
 * Refuse a merge write onto a file that changed since the snapshot read it.
 *
 * The snapshot is read, decided on, sealed and uploaded before anything is
 * written back here, and in that window — two PBKDF2 derivations and a network
 * round trip wide — another program on this computer may write the same file:
 * the host itself does, whenever its own pages change the model catalog or the
 * plugin list. `writeIfChanged` compares bytes, and a merged file that happens
 * to differ would overwrite that write; the copy kept for Undo holds the
 * snapshot, which is from before it, so the write would be gone for good. The
 * mtime the snapshot took is the witness: a mismatch aborts this application
 * with an error the next attempt reads as "sync again", and the next sync
 * merges both writes instead of one of them.
 *
 * Only a merge is guarded. Restore, undo and import are explicit instructions
 * to put the held copy over whatever is there now — waiting for that is what
 * the person asked for — and their copies for the way back are taken from the
 * disk as it is at that moment.
 */
async function refuseIfMoved(file: string, mtimeMs: number): Promise<void> {
  let still: boolean
  try {
    still = (await stat(file)).mtimeMs === mtimeMs
  } catch (cause) {
    // A file that was not there when the snapshot read it and is still not there
    // is unchanged; one that has appeared since is a write this sync never saw.
    still = isMissing(cause) && mtimeMs === 0
  }
  if (still) return
  throw new Error(
    `${file} 在这次同步期间被别的程序改过：本次没有写入，以免覆盖它——请再同步一次，把两边的改动合起来`,
  )
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
  guard: 'merge' | 'overwrite' = 'merge',
): Promise<{ reloadNeeded: boolean; keysProblems: KeyProblem[]; keysWritten: string[] }> {
  const { paths } = engine
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
    if (await dirsDiffer(part, skip, paths.homeDir)) {
      kept = true
      await keepBefore(engine, snapshot, true)
      const wrote = await writeDirs(part, skip, paths.homeDir)
      if (wrote.changed) reloadNeeded = true
    }
  }

  // The skill folders come after the directories with the same bargain: `null`
  // is "the other computer took this part away" and writes nothing here — a sync
  // never removes a folder somebody made by hand — and a folder this run could
  // not read is not written into, since what is there now was never read. The
  // name '' is the root itself, and a root that could not even be listed defers
  // the whole part up in the merge, so this is always a list of folders. See
  // {@link writeSkills}.
  if (applied.skills !== undefined && applied.skills !== null) {
    const part = applied.skills as SkillsPart
    const skip = new Set(
      snapshot.skills.problems.filter((problem) => problem.name !== '').map((problem) => problem.name),
    )
    if (await skillsDiffer(paths.skillsDir, part, skip)) {
      kept = true
      await keepBefore(engine, snapshot, true)
      const wrote = await writeSkills(paths.skillsDir, part, skip)
      if (wrote.changed) reloadNeeded = true
    }
  }

  if (applied.models !== undefined || applied.patch !== undefined || applied.mcp !== undefined) {
    // `null` means "take this away", which is how a removal made on another
    // computer reaches this one. The patch part has no row of its own to remove,
    // so it is emptied instead.
    //
    // The catalog is written where DSH reads it. Usually that is this same file,
    // and the two halves go in one write; on a machine whose home patch carries a
    // model row, that row is the one in force and the profile's copy would be
    // shadowed by it — see `docs/decisions/0071-sync-the-catalog-where-it-takes-effect.md`.
    const inProfile = snapshot.modelsPatch === snapshot.patch
    const next = applyPatch(snapshot.patch, {
      ...(inProfile ? { models: applied.models as Merged['models'] as never } : {}),
      ...(applied.patch === null ? { patch: { entries: [] } } : { patch: applied.patch as Merged['patch'] as never }),
      // The MCP rows are the same three states in their own class of rows: a
      // list replaces, `null` removes, and `undefined` leaves this file's rows
      // as they are (docs/decisions/0075-mcp-and-skills-parts.md).
      ...(applied.mcp === null ? { mcp: { entries: [] } } : { mcp: applied.mcp as Merged['mcp'] as never }),
    })
    if (next !== snapshot.patch.text) {
      if (guard === 'merge') await refuseIfMoved(paths.patchFile, snapshot.patch.mtimeMs)
      if (!kept) {
        kept = true
        await keepBefore(engine, snapshot)
      }
      if (await writeIfChanged(paths.patchFile, next)) reloadNeeded = true
    }
    if (!inProfile && applied.models !== undefined) {
      const written = applyPatch(snapshot.modelsPatch, { models: applied.models as Merged['models'] as never })
      if (written !== snapshot.modelsPatch.text) {
        if (guard === 'merge') await refuseIfMoved(snapshot.modelsFile, snapshot.modelsPatch.mtimeMs)
        if (!kept) {
          kept = true
          await keepBefore(engine, snapshot)
        }
        if (await writeIfChanged(snapshot.modelsFile, written)) reloadNeeded = true
      }
    }
  }

  if (applied.plugins !== undefined) {
    const next = applyManifest(snapshot.manifest, applied.plugins as never)
    if (next !== snapshot.manifest.text) {
      if (guard === 'merge') await refuseIfMoved(paths.packageFile, snapshot.manifest.mtimeMs)
      if (!kept) await keepBefore(engine, snapshot)
      if (await writeIfChanged(paths.packageFile, next)) reloadNeeded = true
    }
  }

  // The keys go last and through the host's credential service rather than a file
  // of this plugin's own ({@link applyKeys}): each one is a call on a store another
  // package owns, so a refusal there leaves the profile's files written and the key
  // reported. Nothing here reloads, either — DSH resolves a credential per call, so
  // the next provider request already sees the new value.
  let keysProblems: KeyProblem[] = []
  let keysWritten: string[] = []
  if (applied.keys !== undefined) {
    const written = await applyKeys(engine.credentials, applied.keys as KeysPart | null, async () => {
      if (kept) return
      kept = true
      await keepBefore(engine, snapshot)
    })
    keysProblems = written.problems
    keysWritten = written.written
  }

  return { reloadNeeded, keysProblems, keysWritten }
}

/** Record measured parts without turning an unreadable key store into a baseline. */
function recordHashes(state: StoredState, local: PartHashes, remote: PartHashes, keysReadable: boolean): void {
  if (keysReadable) state.keysBaseline = true
  if (!keysReadable) {
    // Keep both comparison points: when the service returns, local and remote
    // key edits still need to be merged rather than accepted as already applied.
    if (state.local?.keys === undefined) delete local.keys
    else local.keys = state.local.keys
    remote = { ...remote }
    if (state.remote?.keys === undefined) delete remote.keys
    else remote.keys = state.remote.keys
    // The server may have changed keys during this attempt. A conditional 304
    // would hide its body on recovery even though those keys are still pending.
    state.server = undefined
  }
  state.local = local
  state.remote = remote
}

/**
 * The `keysProblems` field of a result, present only when there is one.
 *
 * The card reads an absent field as "every key went in", so an empty list is left
 * off rather than sent as an empty one to be filtered on the other side.
 */
function keyProblems(problems: KeyProblem[]): { keysProblems?: KeyProblem[] } {
  return problems.length === 0 ? {} : { keysProblems: problems }
}

/**
 * The `keysWritten` field of a result, present only when a key was stored.
 *
 * Names, never values: a reference name is what the profile itself carries, and
 * §"the card says which keys arrived" is the whole of this field. Absent when
 * nothing was written, so a run that only read keeps its result as small as it
 * was before the union merge existed.
 */
function keysStored(refs: string[]): { keysWritten?: string[] } {
  return refs.length === 0 ? {} : { keysWritten: refs }
}

/** A `state.dismissed` of nothing, for reads whose state is not fresh. */
const EMPTY_DISMISS: Dismissed = {}

/**
 * The stable serialization a conditional prompt is dismissed by.
 *
 * The card hides a host-recomputed prompt by asking the host to remember a
 * signature of what was on screen; the next status read with the same payload
 * carries the same signature and is held back, while a different payload —
 * another plugin name, another directory — signs differently and shows. A
 * plain `JSON.stringify` of the payload is stable for this: these payloads are
 * plain arrays of strings and objects with string fields, produced sorted by
 * the host itself, so the same facts always serialise to the same text.
 */
function signatureOf(payload: unknown): string {
  return JSON.stringify(payload)
}

/**
 * Whether a prompt hidden by hand still matches what the host would say now.
 *
 * `dismissed` holds one signature per prompt kind; an absent kind — an old
 * state file, a prompt never dismissed — never matches anything, and a state
 * whose key does not match this configuration is never consulted at all.
 */
function hiddenBy(
  dismissed: Dismissed,
  target: keyof Dismissed,
  signature: string | undefined,
): boolean {
  if (signature === undefined) return false
  return dismissed[target] === signature
}

/**
 * Seal this computer's setup into `sync/before-apply` before a merge writes.
 *
 * `withTrees` is on when the write about to happen touches the extra directories
 * or the skill folders, because that copy is what Undo puts back and a tree left
 * out of it could not be put back. It is off otherwise: a tree can run to
 * megabytes, and a copy taken so that one patch row can be undone has no business
 * carrying it.
 */
async function keepBefore(engine: Engine, snapshot: Snapshot, withTrees = false): Promise<string | undefined> {
  try {
    const parts: Merged = withTrees ? partsOf(snapshot, undefined) : { ...snapshot.parts }
    const bundle: Bundle = {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      created: new Date().toISOString(),
      app: BUNDLE_APP,
      ...bundleParts(parts),
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
  withTrees = false,
): Promise<string> {
  const { paths, config } = engine
  const dir = keptDir(paths)
  const parts: Merged = withTrees ? partsOf(snapshot, undefined) : { ...snapshot.parts }
  const ours: Bundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    created: new Date().toISOString(),
    app: BUNDLE_APP,
    ...bundleParts(parts),
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
 * Hand the model catalog back to the profile patch when a home layer only shadows it.
 *
 * DSH composes the home patch (`$DSH_HOME/cordis.patch.yml`) after the profile's
 * and replaces `config` wholesale, so a model row there is the catalog the host
 * actually lists — while the profile row, the one a sync keeps up to date, is the
 * one nothing reads. That is how a machine whose home layer still carried an
 * older order went on showing it after every sync, with the card reporting the
 * model part as already in step, because the plugin measured the home row as
 * "this computer's catalog" and the server's copy as the same thing.
 *
 * The shadow is *dropped* rather than written into, because a catalog with two
 * owners is worse than either: the host's own Models page edits the profile, so a
 * home row left in place would keep swallowing those edits too. Where the home
 * row is the only catalog it is not a shadow at all — nothing in the profile to
 * expose — and the merge writes the catalog there instead ({@link modelsLayer}).
 *
 * What was dropped is sealed into `sync/` first, like any other write. The repair
 * is skipped on a machine with no home patch, which is almost all of them.
 * See `docs/decisions/0071-sync-the-catalog-where-it-takes-effect.md`.
 */
async function reconcileLayers(engine: Engine): Promise<boolean> {
  const { paths } = engine
  const file = paths.homePatchFile
  if (file === undefined) return false
  const home = await readHomePatch(paths)
  if (home === undefined) return false
  const carried = (patch: PatchFile): boolean =>
    patch.rows.some(row => isModelOverride(row.value) && Object.hasOwn(row.value, 'config'))
  if (!carried(home)) return false
  // Nothing to expose: the home row *is* this machine's catalog.
  if (!carried(await readPatch(paths))) return false

  const next = withoutModels(home)
  if (next === home.text) return false
  await keepLayer(engine, home)
  return await writeIfChanged(file, next)
}

/** Seal what a layer held before a repair rewrites it, so the drop is recoverable. */
async function keepLayer(engine: Engine, patch: PatchFile): Promise<void> {
  try {
    const parts = collect(patch, { value: {}, text: '', mtimeMs: 0 })
    const bundle: Bundle = {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      created: new Date().toISOString(),
      app: BUNDLE_APP,
      ...bundleParts(parts),
    }
    await keepAside(keptDir(engine.paths), 'home-layer', await seal(bundle, engine.config.passphrase))
  } catch {
    // Keeping a copy must never be the reason a sync fails.
  }
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
  state?: StoredState,
): Promise<{ pendingInstall: boolean; pendingNames?: string[] }> {
  if (!engine.config.plugins) return { pendingInstall: false }
  if (declared === undefined) return { pendingInstall: false }
  const installed = await installedPackages(engine.paths)
  const missing = missingPlugins(declared, installed)
  // The names travel with the flag: the card says "these are not installed yet",
  // and a bare true would leave it naming nobody.
  if (missing.length === 0) return { pendingInstall: false }
  // Hidden by hand: the same list was dismissed before, and until the list itself
  // changes — a plugin installed, another one declared — the host keeps quiet
  // about it. The caller passes the state it already loaded; a sync result
  // computed mid-action without one stays visible.
  if (state !== undefined) {
    if (
      state.key === stateKey(engine.config) &&
      hiddenBy(state.dismissed ?? EMPTY_DISMISS, 'pendingInstall', signatureOf(missing))
    ) {
      return { pendingInstall: false }
    }
  }
  return { pendingInstall: true, pendingNames: missing }
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
    if (read.data === undefined) throw new Error('服务器上还没有 dsh 配置：没有可恢复的内容')
    const remote = await openRemote(engine, state, { ...read, notModified: false })
    if (remote.empty) throw new Error('服务器上还没有 dsh 配置：没有可恢复的内容')

    // The same layer repair a sync makes: a catalog written into the profile
    // behind a home row that shadows it would never be read.
    const repaired = await reconcileLayers(engine)
    const snapshot = await take(paths, config, engine.credentials)
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
        // Restore does not weigh who changed what: every part the server carries
        // and this computer has differently is brought in, which is the whole
        // point of the action. A part the server does not carry is not named:
        // nothing was written and nothing was taken away, so a notice claiming
        // it was would describe an event that did not happen.
        if (local[part] !== remote.hashes[part]) here.push(part)
      }
    }

    const kept = await keepBefore(engine, snapshot, true)
    const written = await applyMerged(engine, snapshot, applied, 'overwrite')
    state.undo = kept ?? ''
    state.remote = remote.hashes
    state.local = hashesOf(partsOf(await take(paths, config, engine.credentials), undefined))
    state.sum = read.data === undefined ? state.sum : sum(read.data)
    state.server = read.version
    state.blind = undefined
    state.last = new Date().toISOString()
    state.error = ''
    // Every part named in `here` was written over this computer's copy, or was
    // taken away for Undo; a restore that named none found the two sides alike.
    if (here.length > 0) state.moved = state.last
    state.notice = { at: new Date().toISOString(), here, there: [], ...(kept === undefined ? {} : { saved: keptDir(paths) }), restored: true }
    if (read.data !== undefined) await remember(paths, read.data)
    await saveState(paths, state)
    return {
      here,
      there: [],
      ...(kept === undefined ? {} : { saved: keptDir(paths) }),
      pushed: false,
      reloadNeeded: written.reloadNeeded || repaired,
      ...keyProblems([...snapshot.keysProblems, ...written.keysProblems]),
      ...keysStored(written.keysWritten),
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

    // An upload publishes what this computer holds, so the catalog has to be read
    // — and repaired into the profile — before it is measured.
    const repaired = await reconcileLayers(engine)
    const snapshot = await take(paths, config, engine.credentials)
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
    // An upload is this computer's setup going up wholesale, whatever the server
    // held before: it moved something even when it was asked for as a rescue.
    state.moved = state.last
    await saveState(paths, state)
    return repaired ? { ...result, reloadNeeded: true } : result
  })
}

/**
 * Write this computer's setup into one passphrase-sealed file the person can carry.
 *
 * The file is the same sealed bundle the server holds, so a manual backup and a
 * sync backup are one format and either can be opened by the other. What goes in
 * is what the configuration syncs — the parts behind the switches — because
 * "打包上面这些" means the section above the button, and a part that is switched
 * off is one this person already said they do not want travelling.
 *
 * The passphrase is asked for here rather than taken from the configuration: this
 * file leaves the computer, and the sync passphrase is the one that also opens the
 * copy on the server. A file sealed with its own passphrase opens nothing else.
 */
export async function exportBackup(engine: Engine, body: ExportBody = {}): Promise<ExportResult> {
  return guarded(engine, async () => {
    const { paths, config } = engine
    const passphrase = (body.passphrase ?? '').trim()
    if (passphrase === '') throw new Error('导出需要一个口令来加密这个文件')
    await ensureStateDir(paths)
    const snapshot = await take(paths, config, engine.credentials)
    const whole = partsOf(snapshot, undefined)
    const parts: Merged = {}
    for (const part of PARTS) {
      if (!syncsPart(config, part)) continue
      const value = whole[part]
      if (value !== undefined) parts[part] = value
    }
    const carried = Object.keys(parts) as Part[]
    if (carried.length === 0) throw new Error('这份配置没有可以导出的内容：请先在上面打开要同步的项')

    const bundle: Bundle = {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      created: new Date().toISOString(),
      app: BUNDLE_APP,
      ...bundleParts(parts),
    }
    const sealed = await seal(bundle, passphrase)
    const file = await exportTarget(body.dir)
    await mkdir(dirname(file), { recursive: true })
    try {
      await writeFile(file, sealed, { flag: 'wx' })
    } catch (cause) {
      if (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'EEXIST') {
        throw new Error(`导出文件已存在，不会覆盖：「${file}」。请选择其他文件名或只填写目录`)
      }
      throw cause
    }
    return { file, size: sealed.byteLength, parts: carried }
  })
}

/** Only .prop names a file; dots in an ordinary directory are not an extension hint. */
async function exportTarget(dir: string | undefined): Promise<string> {
  const asked = (dir ?? '').trim()
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').replace('Z', '')
  // Milliseconds plus a random suffix keep repeated exports distinct even across
  // profiles; exclusive writes below protect a file if there still is a collision.
  const name = `dsh-webdav-${stamp}-${randomUUID().slice(0, 8)}${BACKUP_EXT}`
  if (asked === '') return join(homedir(), name)
  if (!isAbsolute(asked)) {
    throw new Error(`导出位置必须是绝对路径，收到的是「${asked}」`)
  }
  const target = resolve(asked)
  let directory = false
  try {
    const existing = await stat(target)
    if (!existing.isDirectory()) throw new Error(`导出文件已存在，不会覆盖：「${target}」。请选择其他文件名或只填写目录`)
    directory = true
  } catch (cause) {
    if (!(typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT')) throw cause
  }
  // Existing directories (even "backups.prop") remain directories. A new full
  // filename is accepted only for this backup format, not an arbitrary extension.
  return !directory && extname(target).toLowerCase() === BACKUP_EXT ? target : join(target, name)
}

/**
 * Put what a picked backup file holds onto this computer.
 *
 * This is the one action that must work on a computer that has never synced: the
 * whole point of the file is to arrive somewhere new. So nothing here asks the
 * configuration to be usable, and nothing is compared with the server.
 *
 * What it does *not* do is touch the sync baseline. The parts change here, the
 * stored hashes still describe the setup from before, so the next sync sees the
 * difference and pushes it — which is what someone who imported a setup on a new
 * computer wants to happen.
 */
export async function importBackup(engine: Engine, body: ImportBody = {}): Promise<ImportResult> {
  return guarded(engine, async () => {
    const { paths, config } = engine
    const passphrase = (body.passphrase ?? '').trim()
    if (passphrase === '') throw new Error('导入需要这个文件的口令')
    const text = body.text ?? ''
    if (text.trim() === '') throw new Error('没有读到文件内容：请重新选择那个备份文件')
    const bundle = await openBackupFile(text, passphrase)
    const unreadable = unreadablePart(bundle)
    if (unreadable !== undefined) {
      throw new Error(`这个文件里「${unreadable}」这一份的形状不是本插件写出来的：它可能来自另一个版本的插件`)
    }

    await ensureStateDir(paths)
    const snapshot = await take(paths, config, engine.credentials)
    const local = hashesOf(partsOf(snapshot, undefined))
    // The file's fields read back as parts — `mcp` apart from `patch`, the view
    // every hash here is measured in.
    const parts = splitParts(bundle)
    const remote = hashesOf(parts)
    const merged: Merged = {}
    const applied: Merged = {}
    const here: Part[] = []
    const same: Part[] = []
    for (const part of PARTS) {
      const value = parts[part]
      if (value === undefined) continue
      // Applied whatever the switches say: a file that was picked and opened is an
      // explicit instruction about this one moment, not a standing arrangement.
      merged[part] = value
      applied[part] = value
      if (local[part] === remote[part]) same.push(part)
      else here.push(part)
    }
    if (here.length === 0) {
      // Nothing differs, so nothing is written: a no-op import that still rewrote
      // every file would only make the reload prompt meaningless.
      return {
        here: [],
        same,
        reloadNeeded: false,
        pendingInstall: false,
        created: bundle.created,
      }
    }

    // A copy is kept only when there is a passphrase to seal it with. On a fresh
    // computer there is none, and `keepBefore` answers `undefined` — the setup
    // being replaced there is the empty one anyway.
    const kept = await keepBefore(engine, snapshot, true)
    const written = await applyMerged(engine, snapshot, applied, 'overwrite')
    const state = await freshState(paths, config)
    const at = new Date().toISOString()
    if (kept !== undefined) state.undo = kept
    state.last = at
    state.error = ''
    state.moved = at
    await saveState(paths, state)
    return {
      here,
      same,
      ...(kept === undefined ? {} : { saved: keptDir(paths) }),
      reloadNeeded: written.reloadNeeded,
      ...(await pendings(engine, applied.plugins as PluginsPart | undefined)),
      ...keyProblems([...snapshot.keysProblems, ...written.keysProblems]),
      ...keysStored(written.keysWritten),
      created: bundle.created,
    }
  })
}

/** Open a picked file's text as a bundle of ours, with messages a person can act on. */
async function openBackupFile(text: string, passphrase: string): Promise<Bundle> {
  const data = Buffer.from(text, 'utf8')
  let opened: unknown
  try {
    opened = await open(data, passphrase)
  } catch (cause) {
    if (cause instanceof PassphraseError) {
      throw new Error('口令打不开这个文件：请用导出它时用的那个口令')
    }
    if (cause instanceof CorruptError) {
      throw new Error(`${cause.message}——这个文件可能没有拷全，请重新导出一次`)
    }
    if (cause instanceof NotBackupError) {
      throw new Error('这个文件不是 dsh-webdav-sync 导出的备份：请选另一个文件')
    }
    throw cause
  }
  if (opened === null || typeof opened !== 'object' || (opened as Bundle).format !== BUNDLE_FORMAT) {
    throw new Error('这个文件不是 dsh-webdav-sync 导出的备份：请选另一个文件')
  }
  const bundle = opened as Bundle
  return { ...bundle, created: typeof bundle.created === 'string' ? bundle.created : new Date(0).toISOString() }
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
    let bundle: Bundle
    try {
      bundle = (await open(new Uint8Array(data), config.passphrase)) as Bundle
    } catch (cause) {
      if (cause instanceof PassphraseError) {
        throw new Error(
          '口令打不开恢复之前留下的那份副本：口令在恢复之后改过。副本还在 sync/ 目录里，用当时的口令就能撤销',
        )
      }
      throw cause
    }
    const snapshot = await take(paths, config, engine.credentials)
    // The copy's fields read back as parts — `mcp` apart from `patch`, which is
    // the view every write here takes.
    const keptParts = splitParts(bundle)
    const merged: Merged = {}
    const applied: Merged = {}
    const back: Part[] = []
    for (const part of PARTS) {
      // Undo is a write to this computer's files like any other, so a part the
      // configuration turned off is left alone here too. The copy it came from
      // keeps the whole setup either way.
      if (!syncsPart(config, part)) continue
      const kept = keptParts[part]
      if (kept === undefined) continue
      merged[part] = kept
      applied[part] = kept
      back.push(part)
    }
    const written = await applyMerged(engine, snapshot, applied, 'overwrite')
    state.undo = ''
    state.notice = undefined
    await saveState(paths, state)
    return {
      here: back,
      there: [],
      pushed: false,
      reloadNeeded: written.reloadNeeded,
      ...keyProblems([...snapshot.keysProblems, ...written.keysProblems]),
      ...keysStored(written.keysWritten),
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
  const snapshot = await take(paths, config, engine.credentials).catch(() => undefined)
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
  // The three conditional prompts respect what the person hid by hand — but only
  // when the state on disk still answers for this configuration, the same rule
  // the notice obeys. Everything else about a mismatched state is ignored here.
  const dismissals = fresh ? state.dismissed ?? EMPTY_DISMISS : EMPTY_DISMISS
  const pendingVisible = missing.length > 0 && !hiddenBy(dismissals, 'pendingInstall', signatureOf(missing))
  const dirList = snapshot?.dirs.problems ?? []
  const dirVisible = dirList.length > 0 && !hiddenBy(dismissals, 'dirProblems', signatureOf(dirList))
  const skillList = snapshot?.skills.problems ?? []
  const skillVisible = skillList.length > 0 && !hiddenBy(dismissals, 'skillProblems', signatureOf(skillList))
  const keyList = snapshot?.keysProblems ?? []
  const keyVisible = keyList.length > 0 && !hiddenBy(dismissals, 'keyProblems', signatureOf(keyList))
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
      // Said only when it is news: the home patch carries the catalog here, so the
      // file the card lists as the patch is not the one the catalog lives in.
      ...(snapshot !== undefined && snapshot.modelsFile !== paths.patchFile
        ? { modelsFile: snapshot.modelsFile }
        : {}),
      packageFile: paths.packageFile,
    },
    ...(fresh && state.last !== undefined && state.last !== '' ? { last: state.last } : {}),
    ...(fresh && state.moved !== undefined && state.moved !== '' ? { moved: state.moved } : {}),
    error: errorApplies && typeof state.error === 'string' ? state.error : '',
    ...(fresh && state.notice !== undefined ? { notice: state.notice } : {}),
    parts,
    pendingInstall: pendingVisible,
    ...(pendingVisible ? { pendingNames: missing } : {}),
    // A directory that could not be read is said here rather than kept quiet: it
    // is the one thing about this feature the person has to act on. A dismissal
    // by signature keeps the very list that was hidden off the card; a different
    // list — another directory, another reason — signs differently and shows.
    ...(dirVisible ? { dirProblems: dirList } : {}),
    // The same, for a skill folder that could not be read: the sync leaves that
    // folder as the server has it rather than read it as empty, and this is the
    // card's way to say which one and why.
    ...(skillVisible ? { skillProblems: skillList } : {}),
    // The same, for a key that could not be read: a store that cannot be read must
    // not look like a store with nothing in it, or this computer would look like
    // one with no keys and the next sync would believe it.
    ...(keyVisible ? keyProblems(keyList) : {}),
    undoable: fresh && state.undo !== undefined && state.undo !== '',
  }
}

/**
 * The card's "dismiss": put away what the person asked to put away.
 *
 * Without a target this clears the sync notice, as it always did. With a target
 * it records the on-screen payload's signature under that kind of prompt: the
 * host keeps saying nothing while its recomputed payload signs the same, and
 * starts saying it again the moment the payload differs — a plugin installed,
 * another one declared, a directory fixed or a new one failing. The signature,
 * not a bare flag, is what keeps "hide this" from growing into "hide this
 * forever, even when the facts change".
 */
export async function dismiss(engine: Engine, target?: DismissTarget, signature?: string): Promise<void> {
  // Through the same serial queue as every other state writer: a dismiss that
  // read the state before a sync in flight wrote its result would write the old
  // state back over it, and the baseline the next sync compares against would
  // quietly become one from before that sync.
  return guarded(engine, async () => {
    const state = await loadState(engine.paths)
    if (state.key !== stateKey(engine.config)) return
    if (target === undefined) {
      state.notice = undefined
    } else {
      if (typeof signature !== 'string' || signature === '') return
      const dismissed: Dismissed = { ...state.dismissed }
      if (target === 'pending-install') dismissed.pendingInstall = signature
      if (target === 'dir-problems') dismissed.dirProblems = signature
      if (target === 'skill-problems') dismissed.skillProblems = signature
      if (target === 'key-problems') dismissed.keyProblems = signature
      state.dismissed = dismissed
    }
    await saveState(engine.paths, state)
  })
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
    plugins: config.plugins,
    patch: config.patch,
    keys: config.keys,
    mcp: config.mcp,
    skills: config.skills,
    dirs: [...config.dirs],
    dirsEnabled: config.dirsEnabled,
    rememberPassword: config.rememberPassword,
    headers: config.headers,
    relayEnabled: config.relayEnabled,
    relayPort: config.relayPort,
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
  const snapshot = await take(paths, config, engine.credentials)
  // Built exactly as `syncOnce` builds it, including the deletion: a credential
  // store that could not be read is unknown rather than empty, and the sync
  // leaves that part out of what it uploads. A preview that kept it would promise
  // a first sync a key upload that sync then does not make.
  const localParts = partsOf(snapshot, carriedOf(remote))
  if (snapshot.keysProblems.length > 0) delete localParts.keys
  const local = hashesOf(localParts)
  const first = state.local === undefined
  const changes: PreviewChange[] = []
  // The merge loop of `syncOnce` is one call to {@link moveFor} per part; this is
  // the same call, so what the card promises and what the sync then does cannot
  // drift apart. A part the merge would write is the part that shows up here — a
  // first sync against an empty server promises an upload, not six fetches.
  for (const part of PARTS) {
    const move: PartMove = remote.empty
      // Nothing on the server to merge with: the sync uploads whatever this
      // computer carries, and the card says so instead of promising a fetch.
      ? syncsPart(config, part) && local[part] !== undefined
        ? { take: 'mine', conflict: false }
        : { take: 'nothing', conflict: false }
      : moveFor({
          part,
          config,
          first,
          state,
          snapshot,
          local,
          localParts,
          remoteHash: remote.hashes[part],
          remotePart: remote.part(part),
          remoteCreated: remote.created,
        })
    switch (move.take) {
      case 'mine':
      case 'push-back':
        changes.push({ part, take: move.conflict ? 'newer-local' : 'local' })
        break
      case 'theirs':
        changes.push({ part, take: move.conflict ? 'newer-remote' : 'remote' })
        break
      case 'union':
        // Both sides added keys since the last sync, and the sync keeps both
        // sets: the card says the two are on their way into one, which is the
        // promise the merge below keeps.
        changes.push({ part, take: 'both' })
        break
      case 'drop':
        // The card has no word for "take it away", and the answer the sync gives
        // is a fetch of the server's absent copy; `remote` is the truthful side
        // of that pair.
        changes.push({ part, take: 'remote' })
        break
      default:
        // `off`, `same`, `keep-off`, `carry-*` and `nothing` write nothing: the
        // sync would leave both sides as they are, so the card says nothing.
        break
    }
  }
  return { changes }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Read this computer's setup and the files it came from, in one pass. */
export async function take(
  paths: ResolvedPaths,
  config: SyncConfig,
  credentials?: KeysPort | undefined,
): Promise<Snapshot> {
  const patch = await readPatch(paths)
  const manifest = await readManifest(paths)
  // The home patch is applied after the profile's, so a model row there is the one
  // DSH reads and the one a sync has to write. A machine without it — most of them
  // — keeps the profile patch as the catalog's home and nothing below changes.
  const home = await readHomePatch(paths)
  const modelsPatch = modelsLayer(patch, home)
  const modelsFile = home !== undefined && modelsPatch === home ? paths.homePatchFile! : paths.patchFile
  // Switched off, the directories are not walked at all: reading them is the one
  // part of a snapshot that can cost a great deal, and a part this configuration
  // does not carry has nothing to say. An empty read still tells the merge there is
  // nothing here to compare, which is exactly true.
  const dirs = await readDirs(config.dirsEnabled ? config.dirs : [], paths.homeDir)
  // The skill folders, walked only while this configuration carries them — the
  // same "nothing to say" the directories get when switched off. Their root is
  // absent on a host with no home directory named, and absent reads as empty.
  const skills = config.skills ? await readSkills(paths.skillsDir) : { entries: [], mtimeMs: 0, problems: [] }
  const parts = collect(patch, manifest, modelsPatch)
  // The keys, read from the names the parts above just named — plus the ones the
  // extra directories' files name (a plugin's own index can list keys the profile
  // never does; see {@link dirRefs}). Switched off, they
  // are not read at all — the same "nothing to say" the directories get — and a
  // host with no credential store resolves nothing rather than reading as empty.
  const keys = config.keys ? await readKeys(credentials, parts, dirRefs(dirs.entries)) : { problems: [] }
  if (keys.part !== undefined) parts.keys = keys.part
  return { patch, modelsPatch, modelsFile, manifest, parts, dirs, skills, keysProblems: keys.problems }
}

/**
 * A bundle's fields read back as parts: the `mcp` rows are lifted out of the
 * `patch` field they travel in, so the two parts are apart again before anything
 * is hashed or merged.
 *
 * The split is a view, not a file format — see `docs/decisions/0075-mcp-and-skills-parts.md`.
 * `{entries: []}` counts as the part being away, the same rule `collect` writes by.
 */
function splitParts(bundle: Partial<Bundle>): Merged {
  const source = bundle as Record<string, unknown>
  const out: Merged = {}
  for (const part of PARTS) {
    if (part === 'mcp' || part === 'patch') continue
    const value = source[part]
    if (value !== undefined) out[part] = value
  }
  const field = bundle.patch
  if (field !== undefined) {
    const { rest, mcp } = splitMcp(field.entries)
    if (rest.length > 0) out.patch = { entries: rest }
    if (mcp.length > 0) out.mcp = { entries: mcp }
  }
  return out
}

/**
 * The parts as a bundle's fields, the other half of {@link splitParts}: the `mcp`
 * rows rejoin the `patch` field, so the file the server holds is byte-for-byte
 * the one a version that does not know the part has always read and written.
 * `splitParts(bundleParts(parts))` gives the parts back unchanged.
 */
function bundleParts(parts: Merged): Partial<Bundle> {
  const out: Record<string, unknown> = {}
  for (const part of PARTS) {
    if (part === 'mcp' || part === 'patch') continue
    const value = (parts as Record<string, unknown>)[part]
    if (value !== undefined) out[part] = value
  }
  const rest = (parts.patch as PatchPart | undefined)?.entries ?? []
  const mcp = (parts.mcp as McpPart | undefined)?.entries ?? []
  if (parts.patch !== undefined || parts.mcp !== undefined) out.patch = { entries: joinMcp(rest, mcp) }
  return out as Partial<Bundle>
}

/**
 * Per-part hashes of a setup; a part that is not there has none.
 *
 * The model catalog is hashed through `modelsIdentity`, so the order of the
 * routes inside `config.providers` counts as part of the part: DSH lists the
 * models in exactly that order, and a plain `hashJson` sorts object keys and
 * would report two catalogs that differ only in that order as the same setup.
 *
 * The parts are the split view — `mcp` apart from `patch`, as {@link splitParts}
 * leaves them — so the two parts are told apart here too, and the `patch` hash
 * covers the rows of that part only.
 */
export function hashesOf(parts: Partial<Record<Part, unknown>>): PartHashes {
  const source = parts as Record<string, unknown>
  const out: PartHashes = {}
  for (const part of PARTS) {
    const value = source[part]
    if (value !== undefined) out[part] = hashJson(part === 'models' ? modelsIdentity(value) : value)
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
  // The skill folders have no single file of their own either: the newest file
  // inside any of them stands for the whole part.
  if (part === 'skills') return snapshot.skills.mtimeMs
  // A credential has neither a file of this plugin's own nor a time the host's
  // store reports, so there is nothing to weigh the server's stamp against. This
  // computer's copy wins instead — it is the one that authenticates the requests
  // made here, and it may have been stored a moment ago through the Models page,
  // which touches no profile file at all. The copy that loses is archived by
  // {@link keepConflict} like any other. See `docs/decisions/0054-sync-api-keys.md`.
  if (part === 'keys') return Number.POSITIVE_INFINITY
  // The catalog's own layer, which is the home patch when DSH reads the catalog
  // from there: the time it was last written is the one that matters.
  if (part === 'models') return snapshot.modelsPatch.mtimeMs
  // The patch file's own time stands for it and for the MCP rows, which are rows
  // of the same file — see `docs/decisions/0075-mcp-and-skills-parts.md`.
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
export function pathsOf(profileDir: string, homeDir?: string): ResolvedPaths {
  return resolvePaths(profileDir, homeDir)
}

export { loadConfig, sameAccount, saveConfig, usable, missingPlugins }
export type { PreviewResult }
