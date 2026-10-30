/**
 * The extra directories: reading them into the `dirs` part, and writing that
 * part back out.
 *
 * The profile parts are read from two files whose shape this plugin already
 * knows. This one is different in three ways, and each of them shapes the code
 * below:
 *
 * - **It is a whole tree, not a file.** Reading means walking, so it is capped:
 *   a directory over the cap is refused as a whole rather than half-carried,
 *   because half a directory that then gets pushed would delete the rest for
 *   everybody else.
 * - **Its path is part of the data.** The user names a directory; the path
 *   travels so a restore writes back into the same directory instead of inventing
 *   one. A path this computer cannot make sense of is therefore not an error to
 *   shout about — it is a directory to leave exactly as the server has it. A path
 *   beginning with `~` is the one exception: it travels as written, and each
 *   computer resolves it against *its own* DSH home, so the same `~/dsh-model-think-level`
 *   names this machine's folder on every machine no matter who runs DSH there
 *   (see `docs/decisions/0079-home-relative-extra-directories.md`).
 * - **Writing is additive.** A sync writes and overwrites files here; it never
 *   removes one. Mirrored deletion inside a person's own directory is the one
 *   accident this feature could cause that no notice could undo, and a union is
 *   the safe half of the trade: a file deleted on one computer comes back from the
 *   others, and deleting it everywhere is done by hand — the same bargain the
 *   plugin already makes for the plugin list (see
 *   `docs/decisions/0005-four-parts-and-plugin-exception.md`).
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isMissing, message, writeIfChanged } from './store.js'
import type { DirProblem, DirSpec, DirsPart } from './wire.js'

/**
 * Names never descended into. `node_modules` because a plugin's own dependencies
 * are installed on each computer rather than carried, `.git` because a repository
 * there has an owner of its own. Both are skipped in silence: a skipped name is
 * not a directory that failed to read.
 */
export const DIRS_SKIP: ReadonlySet<string> = new Set(['node_modules', '.git'])

/** Most files one configured directory may carry. */
export const DIRS_MAX_FILES = 2000
/** Most bytes one configured directory may carry, before base64 and sealing. */
export const DIRS_MAX_BYTES = 8 * 1024 * 1024

/** One directory's files, as they were read. */
export interface TreeRead {
  files: DirSpec['files']
  /** Newest modification time among the files read; 0 when there were none. */
  mtimeMs: number
}

/** What reading the configured directories produced. */
export interface DirsRead {
  /** The directories that could be read, in the configured order. */
  entries: DirSpec[]
  /** Newest modification time among every file read; 0 when nothing was read. */
  mtimeMs: number
  /** Directories that could not be read, and why. */
  problems: DirProblem[]
}

/** Writing reported back to the caller, for the run's own bookkeeping. */
export interface DirsWrite {
  /** True when at least one file's bytes were written. */
  changed: boolean
  /** The absolute paths the part carried, in order, for the configuration to record. */
  paths: string[]
}

/**
 * The stored list of directories: strings only, trimmed, no blanks, no repeats,
 * in a fixed order.
 *
 * The order is by path rather than by when each was added, so the same set of
 * directories hashes the same on every computer — the part is hashed whole, and
 * two computers that name the same directories in a different order would
 * otherwise see a change that is not one.
 */
export function normaliseDirs(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const one of value) {
    if (typeof one !== 'string') continue
    const path = one.trim()
    if (path === '' || out.includes(path)) continue
    out.push(path)
  }
  return out.sort(comparePath)
}

/** Path order, used wherever the set of directories is put in canonical order. */
export function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Whether a configured path is home-relative: `~` itself, or `~` followed by a
 * separator. `~user` is not this — it names another account's home in a shell,
 * and here it is just a relative path that will be refused like any other.
 */
export function homeRelative(path: string): boolean {
  return path === '~' || path.startsWith('~/') || path.startsWith('~\\')
}

/**
 * A configured path as this computer holds it, or `undefined` when it cannot be
 * resolved here.
 *
 * A plain path is itself; a `~`-prefixed one is resolved against the DSH home
 * the caller knows (`$DSH_HOME`, or the user home's `.dsh`), which is the folder
 * whose side data — a plugin's own state, the skills, the home patch — every
 * computer keeps in its own place. An unknown home makes every `~` path
 * unresolvable, which the callers report rather than guess at.
 */
export function expandHome(path: string, home: string | undefined): string | undefined {
  if (!homeRelative(path)) return path
  if (home === undefined || home.trim() === '') return undefined
  const rest = path.slice(1).replace(/^[\\/]+/, '')
  return rest === '' ? resolve(home) : join(resolve(home), rest)
}

/**
 * Read every configured directory.
 *
 * Nothing throws: this runs on every status call, and a card that cannot be
 * opened because a directory on a disconnected drive is not there would be worse
 * than a card that says so. What cannot be read is reported in `problems`, and
 * {@link dirsPartOf} decides what to do about it.
 *
 * `home` is this computer's DSH home, for the `~`-prefixed paths. The part
 * carries the path as it was written — `~/dsh-model-think-level` stays
 * `~/dsh-model-think-level` on the wire — so every computer resolves the same
 * name against its own home, and a machine that cannot resolve it says so
 * instead of reading some other folder as this one.
 */
export async function readDirs(dirs: readonly string[], home?: string | undefined): Promise<DirsRead> {
  const entries: DirSpec[] = []
  const problems: DirProblem[] = []
  let mtimeMs = 0
  for (const path of normaliseDirs(dirs)) {
    const target = expandHome(path, home)
    if (target === undefined) {
      problems.push({
        path,
        message: '这台电脑说不出 DSH 主目录在哪里，~ 开头的目录读不了',
      })
      continue
    }
    if (!isAbsolute(target)) {
      problems.push({
        path,
        message: '这个路径在这台电脑上不是绝对路径，可能是另一台电脑上的目录',
      })
      continue
    }
    try {
      const read = await readTree(target)
      entries.push({ path, files: read.files })
      mtimeMs = Math.max(mtimeMs, read.mtimeMs)
    } catch (cause) {
      // A directory that is not there is reported like any other problem — this
      // computer must not read it as "empty" and push that as a deletion — but it
      // is marked as merely absent, because a restore has to be able to create it and
      // "could not read" must not stop the one write that is the whole point.
      problems.push(
        isMissing(cause)
          ? { path, message: '这台电脑上还没有这个目录', missing: true }
          : { path, message: message(cause) },
      )
    }
  }
  return { entries, mtimeMs, problems }
}

/**
 * The `dirs` part this computer holds, given what the server holds.
 *
 * Without a problem this is simply what is on disk — and `undefined` when there is
 * nothing on disk, which keeps a computer that syncs no directories from putting an
 * empty `dirs` part on the server and quietly emptying it for the computers that do.
 *
 * With a problem it is still what is on disk, except for the directories that could
 * not be read: those take the server's copy verbatim. That is the whole reason this
 * function exists. Reading a directory that is not there as "a directory with no
 * files in it" would make the next push announce that every file in it was deleted,
 * and a disconnected drive would quietly empty everybody else's copy of it. Carrying
 * the server's copy instead means such a directory is neither read nor written this
 * run, and the card says which one it was.
 */
export function dirsPartOf(read: DirsRead, carried: DirsPart | undefined): DirsPart | undefined {
  if (read.problems.length === 0) return read.entries.length === 0 ? undefined : { dirs: read.entries }
  const unreadable = new Set(read.problems.map((problem) => problem.path))
  const fromDisk = new Map(read.entries.map((dir) => [dir.path, dir]))
  const fromServer = new Map((carried?.dirs ?? []).map((dir) => [dir.path, dir]))
  const dirs: DirSpec[] = []
  for (const path of normaliseDirs([...fromDisk.keys(), ...unreadable])) {
    const entry = fromDisk.get(path) ?? fromServer.get(path)
    if (entry !== undefined) dirs.push(entry)
  }
  return dirs.length === 0 ? undefined : { dirs }
}

/**
 * Put one `dirs` part on disk.
 *
 * Only directories that resolve on this computer are touched: the list travels,
 * so a path another computer named may not be a path here — an absolute one from
 * another machine, or a `~` one when the DSH home is unknown — and writing into
 * a made-up relative one would scatter files around the working directory. Those
 * paths stay in the list — the part is carried whole, and dropping one here
 * would delete it for the computers that can use it — and are simply not read or
 * written on this machine.
 *
 * `skip` holds the directories this run could not read, by the path as it was
 * configured. They are left alone for the same reason {@link dirsPartOf} carries
 * them: whatever is at that path now is not this sync's business to replace, and
 * it may well be nothing at all.
 */
export async function writeDirs(part: DirsPart, skip: ReadonlySet<string>, home?: string | undefined): Promise<DirsWrite> {
  let changed = false
  const paths: string[] = []
  const seen = new Set<string>()
  for (const dir of part.dirs) {
    const path = dir.path.trim()
    if (path === '' || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
    const target = expandHome(path, home)
    if (target === undefined || !isAbsolute(target) || skip.has(path)) continue
    for (const file of dir.files) {
      const file_path = under(target, file.path)
      if (file_path === undefined) continue
      if (await writeIfChanged(file_path, Buffer.from(file.data, 'base64'))) changed = true
    }
  }
  paths.sort(comparePath)
  return { changed, paths }
}

/**
 * Whether writing the part would change anything on disk.
 *
 * Asked before the copy kept for Undo is taken. That copy carries the directories
 * when they are about to be written to, and a tree can run to megabytes — sealing one
 * on every sync whose server copy of this part merely *existed* would cost a
 * profile-size file per sync for a write that changes no file, which is exactly what
 * happens on a computer that syncs no directories of its own and is sent somebody's.
 */
export async function dirsDiffer(part: DirsPart, skip: ReadonlySet<string>, home?: string | undefined): Promise<boolean> {
  for (const dir of part.dirs) {
    const path = dir.path.trim()
    const target = expandHome(path, home)
    if (target === undefined || !isAbsolute(target) || skip.has(path)) continue
    for (const file of dir.files) {
      const file_path = under(target, file.path)
      if (file_path === undefined) continue
      let current: Buffer
      try {
        current = await readFile(file_path)
      } catch {
        // Not there, or not readable: either way a write would try, and trying is
        // what reports the problem properly.
        return true
      }
      if (!current.equals(Buffer.from(file.data, 'base64'))) return true
    }
  }
  return false
}

/** The absolute path of a carried file inside its directory, or nothing. */
export function under(root: string, path: string): string | undefined {
  if (typeof path !== 'string' || path === '') return undefined
  // An absolute path names somewhere else by construction, whatever the platform
  // calls absolute.
  if (isAbsolute(path)) return undefined
  // Carried paths are `/`-separated because `readTree` writes them that way. On
  // Windows a backslash separates too, so a path spelled `..\..\x` would look like
  // one harmless segment while `join` walked two levels up: both separators are
  // split there. On other platforms a backslash is a legal filename character and
  // splitting on it would rename the file, so only `/` counts.
  const parts = path.split(sep === '\\' ? /[\\/]+/ : '/').filter((part) => part !== '' && part !== '.')
  // A `..` in a carried path is never written outside the directory it belongs to.
  if (parts.length === 0 || parts.some((part) => part === '..')) return undefined
  return join(root, ...parts)
}

/** Walk one directory, honouring the skip list and both caps. */
export async function readTree(root: string): Promise<TreeRead> {
  const files: DirSpec['files'] = []
  let mtimeMs = 0
  let bytes = 0

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      // A symlink is not followed: what it points at belongs to whoever put it
      // there, and following one can walk out of the directory or around in a
      // circle.
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (DIRS_SKIP.has(entry.name)) continue
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(full)
      if (files.length >= DIRS_MAX_FILES) {
        throw new Error(`文件超过 ${DIRS_MAX_FILES} 个，这一份没有同步`)
      }
      bytes += info.size
      if (bytes > DIRS_MAX_BYTES) {
        throw new Error(`内容超过 ${Math.round(DIRS_MAX_BYTES / (1024 * 1024))} MiB，这一份没有同步`)
      }
      const data = await readFile(full)
      files.push({ path: relative(root, full).split(sep).join('/'), data: data.toString('base64') })
      mtimeMs = Math.max(mtimeMs, info.mtimeMs)
    }
  }

  await walk(root)
  files.sort((a, b) => comparePath(a.path, b.path))
  return { files, mtimeMs }
}
