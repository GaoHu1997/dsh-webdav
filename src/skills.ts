/**
 * The `skills` part: the skill folders under `$DSH_HOME/skills`.
 *
 * A skill is a directory the host discovers by scanning that root — the panel
 * writes `$DSH_HOME/skills/<name>/SKILL.md` and nothing registers the name, so
 * the directory *is* the skill. This module reads those directories whole (files
 * and all, like `dirs`), writes them back add-only, and says which one it could
 * not read so the server's copy of that one is carried instead of guessed at.
 *
 * Two things under the root deliberately do not travel: `state.json` and
 * `repos/`. Both belong to the panel's skill *sources* — registered local and
 * git folders whose materialised checkouts live under `repos/` with absolute
 * machine paths recorded in the state file. They are re-derivable on the machine
 * that has the sources, meaningless on one that does not, and never written by
 * this plugin. What travels is the skill folders a person put under the root.
 *
 * The mirror of {@link readTree}'s bargain applies here per skill: a skill over
 * the caps is reported and carried from the server rather than half-read, and a
 * sync never removes a file — see {@link writeSkills}.
 */

import { readdir, readFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { comparePath, readTree, under } from './dirs.js'
import { isMissing, message, writeIfChanged } from './store.js'
import type { SkillProblem, SkillSpec, SkillsPart } from './wire.js'

/** What marks a directory as a skill, and the spelling a disabled one keeps. */
const SKILL_FILE = 'SKILL.md'
const SKILL_FILE_DISABLED = 'SKILL.md.disabled'

/** The skills on disk, walked, with whatever could not be read. */
export interface SkillsRead {
  /** One entry per skill folder, in name order. */
  entries: SkillSpec[]
  /** The newest modification time of any file read, for the conflict stamp. */
  mtimeMs: number
  /**
   * Skills this run could not read, with the reason. A `name` of `''` is the
   * root itself — nothing can be said about any skill on this computer then.
   */
  problems: SkillProblem[]
}

/** The outcome of putting one `skills` part on disk. */
export interface SkillsWrite {
  changed: boolean
  /** Every skill name in the part, written or not, sorted. */
  paths: string[]
}

/**
 * The absolute path of one skill's directory, or nothing when its name is not
 * exactly one path segment.
 *
 * A name is carried in a file and then joined onto the root, so it is held to
 * {@link under}'s traversal guard and then some: a skill is *one* directory
 * under the root, so `a/b` is refused rather than followed two levels down.
 */
function skillDir(root: string, name: string): string | undefined {
  const target = under(root, name)
  if (target === undefined) return undefined
  return dirname(target) === resolve(root) ? target : undefined
}

/**
 * Read every skill folder under one root. This never throws: a skill that cannot
 * be read is a {@link SkillProblem}, not a failed sync.
 *
 * An absent root is a machine that has no skills yet — an empty answer, the same
 * one a missing patch file gives. A root that exists but cannot be read is a
 * problem with no name, and makes every skill unknowable here.
 */
export async function readSkills(root: string | undefined): Promise<SkillsRead> {
  if (root === undefined) return { entries: [], mtimeMs: 0, problems: [] }
  let listed: Dirent[]
  try {
    listed = await readdir(root, { withFileTypes: true })
  } catch (cause) {
    if (isMissing(cause)) return { entries: [], mtimeMs: 0, problems: [] }
    return { entries: [], mtimeMs: 0, problems: [{ name: '', message: message(cause) }] }
  }
  const entries: SkillSpec[] = []
  const problems: SkillProblem[] = []
  let mtimeMs = 0
  const names = listed
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(comparePath)
  for (const name of names) {
    const dir = skillDir(root, name)
    if (dir === undefined) continue
    let listing: string[]
    try {
      listing = await readdir(dir)
    } catch (cause) {
      // A directory that cannot even be listed may or may not be a skill — there
      // is no way to tell without reading it — so it is reported rather than
      // quietly passed over. If the server has one of this name, its copy is
      // carried (see {@link skillsPartOf}); if it has none, nothing is lost.
      problems.push({ name, message: message(cause) })
      continue
    }
    if (!listing.includes(SKILL_FILE) && !listing.includes(SKILL_FILE_DISABLED)) continue
    try {
      const tree = await readTree(dir)
      entries.push({ name, files: tree.files })
      if (tree.mtimeMs > mtimeMs) mtimeMs = tree.mtimeMs
    } catch (cause) {
      // The caps land here, and so does anything that broke mid-walk: a skill
      // this run could not hold whole is not half-sent.
      problems.push({ name, message: message(cause) })
    }
  }
  return { entries, mtimeMs, problems }
}

/**
 * The `skills` part this computer holds, given what the server holds.
 *
 * Without problems this is what is on disk — and `undefined` when there is
 * nothing, so a computer with no skills never puts an empty `skills` part on the
 * server and quietly empties it for the computers that have some.
 *
 * A skill that could not be read takes the server's copy verbatim, for the
 * reason {@link dirsPartOf} gives: reading a folder that will not open as "a
 * folder with no files in it" would announce every file in it as deleted. A root
 * that could not be read leaves nothing to say at all, and the server's whole
 * copy stands in.
 */
export function skillsPartOf(read: SkillsRead, carried: SkillsPart | undefined): SkillsPart | undefined {
  if (read.problems.some((problem) => problem.name === '')) return carried
  if (read.problems.length === 0) return read.entries.length === 0 ? undefined : { skills: read.entries }
  const unreadable = new Set(read.problems.map((problem) => problem.name))
  const fromDisk = new Map(read.entries.map((skill) => [skill.name, skill]))
  const fromServer = new Map((carried?.skills ?? []).map((skill) => [skill.name, skill]))
  const skills: SkillSpec[] = []
  for (const name of [...new Set([...fromDisk.keys(), ...unreadable])].sort(comparePath)) {
    const entry = fromDisk.get(name) ?? fromServer.get(name)
    if (entry !== undefined) skills.push(entry)
  }
  return skills.length === 0 ? undefined : { skills }
}

/**
 * Put one `skills` part on disk.
 *
 * Add-only, like `dirs`: a skill the part does not name is left exactly as it
 * is. `null` on the merged part therefore means nothing here — a sync never
 * removes somebody's own files, and a skill taken away on another computer is
 * simply not refreshed on this one.
 *
 * `skip` holds the skills this run could not read, and a name that is not one
 * safe segment under the root is not touched either: what is there now was never
 * read, and replacing it would be writing blind.
 */
export async function writeSkills(
  root: string | undefined,
  part: SkillsPart,
  skip: ReadonlySet<string>,
): Promise<SkillsWrite> {
  let changed = false
  const paths: string[] = []
  const seen = new Set<string>()
  for (const skill of part.skills) {
    const name = skill.name.trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    paths.push(name)
    if (root === undefined || skip.has(name)) continue
    const dir = skillDir(root, name)
    if (dir === undefined) continue
    for (const file of skill.files) {
      const target = under(dir, file.path)
      if (target === undefined) continue
      if (await writeIfChanged(target, Buffer.from(file.data, 'base64'))) changed = true
    }
  }
  paths.sort(comparePath)
  return { changed, paths }
}

/**
 * Whether writing the part would change anything on disk.
 *
 * Asked before the copy kept for Undo is taken, for the same reason as
 * {@link dirsDiffer}: a skill tree can run to megabytes, and sealing one on every
 * sync whose server copy merely *existed* would cost a profile-size file per
 * sync for a write that changes no file.
 */
export async function skillsDiffer(
  root: string | undefined,
  part: SkillsPart,
  skip: ReadonlySet<string>,
): Promise<boolean> {
  if (root === undefined) return false
  for (const skill of part.skills) {
    const name = skill.name.trim()
    if (skip.has(name)) continue
    const dir = skillDir(root, name)
    if (dir === undefined) continue
    for (const file of skill.files) {
      const target = under(dir, file.path)
      if (target === undefined) continue
      let current: Buffer
      try {
        current = await readFile(target)
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
