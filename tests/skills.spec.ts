/**
 * The skill folders: reading them into the `skills` part, and writing them back.
 *
 * The mirror of the extra directories, and the same three places show it — a
 * tree is walked rather than parsed, the name travels in the data, and writing
 * is additive. The differences are all at the edges: a skill is *one* folder
 * under a root this plugin does not configure, named by what it holds rather
 * than by anything registered; the panel's own bookkeeping under that root does
 * not travel at all; and one unreadable folder is that folder's problem alone
 * while the rest of the part is still read.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DIRS_MAX_BYTES } from '../src/dirs.ts'
import { readSkills, skillsDiffer, skillsPartOf, writeSkills } from '../src/skills.ts'
import { cleanUp, tempDir } from './harness.ts'
import type { SkillsPart } from '../src/wire.ts'

afterEach(async () => {
  await cleanUp()
})

/** A skills root holding the given files, keyed by a `/`-separated path. */
async function tree(files: Record<string, string>): Promise<string> {
  const root = await tempDir()
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, ...path.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, text, 'utf8')
  }
  return root
}

/** The files of one carried skill, as path → text. */
function contentsOf(part: SkillsPart | undefined, name: string): Record<string, string> {
  const skill = (part?.skills ?? []).find((one) => one.name === name)
  expect(skill).toBeDefined()
  const out: Record<string, string> = {}
  for (const file of skill?.files ?? []) out[file.path] = Buffer.from(file.data, 'base64').toString('utf8')
  return out
}

describe('reading the skills on this computer', () => {
  it('carries each folder that holds a SKILL.md, named and with its files', async () => {
    const root = await tree({
      'alpha/SKILL.md': '# alpha',
      'alpha/nested/one.txt': 'one',
      'beta/SKILL.md': '# beta',
    })
    const read = await readSkills(root)

    expect(read.problems).toEqual([])
    expect(read.entries.map((skill) => skill.name)).toEqual(['alpha', 'beta'])
    // The names are relative to the skill folder and `/`-separated on every
    // platform, because the part travels and a Windows `\` would arrive as a
    // filename on the other computer.
    expect(contentsOf(skillsPartOf(read, undefined), 'alpha')).toEqual({
      'SKILL.md': '# alpha',
      'nested/one.txt': 'one',
    })
    expect(read.mtimeMs).toBeGreaterThan(0)
  })

  it('reads a disabled skill exactly the same', async () => {
    // Turning a skill off is renaming its one file, so the folder is still
    // somebody's setup and still travels — with the spelling that marks it off.
    const root = await tree({ 'gone/SKILL.md.disabled': '# gone', 'gone/keep.txt': 'keep' })
    const read = await readSkills(root)
    expect(read.entries.map((skill) => skill.name)).toEqual(['gone'])
    expect(contentsOf(skillsPartOf(read, undefined), 'gone')).toEqual({
      'SKILL.md.disabled': '# gone',
      'keep.txt': 'keep',
    })
  })

  it('a folder without either spelling is not a skill', async () => {
    // The panel's own files sit under this root too — state.json and the
    // repos/ checkouts are that machine's business and never travel — and so
    // does anything else a person keeps here.
    const root = await tree({
      'alpha/SKILL.md': 'x',
      'notes/readme.txt': 'r',
      'loose.txt': 'l',
      'state.json': '{"skillRoots":[]}',
    })
    const read = await readSkills(root)
    expect(read.entries.map((skill) => skill.name)).toEqual(['alpha'])
  })

  it('skips node_modules and .git inside a skill, and says nothing about them', async () => {
    const root = await tree({
      'alpha/SKILL.md': 'x',
      'alpha/keep.txt': 'keep',
      'alpha/node_modules/pkg/index.js': 'module.exports = 1',
      'alpha/.git/config': '[core]',
    })
    const read = await readSkills(root)
    expect(contentsOf(skillsPartOf(read, undefined), 'alpha')).toEqual({ 'SKILL.md': 'x', 'keep.txt': 'keep' })
    expect(read.problems).toEqual([])
  })

  it('a root that is not there is a computer with no skills yet', async () => {
    const read = await readSkills(join(await tempDir(), 'not-there'))
    expect(read.entries).toEqual([])
    expect(read.problems).toEqual([])
    expect((await readSkills(undefined)).problems).toEqual([])
  })

  it('a root that cannot be read says so and names nothing', async () => {
    // Nothing can be said about any skill on this computer then, so the problem
    // carries no name and the whole part defers to the server (below).
    const root = await tempDir()
    const file = join(root, 'file.txt')
    await writeFile(file, 'x', 'utf8')
    const read = await readSkills(file)

    expect(read.entries).toEqual([])
    expect(read.problems).toHaveLength(1)
    expect(read.problems[0].name).toBe('')
    expect(read.problems[0].message).not.toBe('')
  })

  it('refuses a skill over the size cap as a whole, and still reads the ones beside it', async () => {
    // One folder per problem here, unlike the extra directories' whole-tree
    // caps: a huge skill is that skill's misfortune and not the part's.
    const root = await tree({
      'big/SKILL.md': 'x'.repeat(DIRS_MAX_BYTES + 1),
      'small/SKILL.md': 's',
    })
    const read = await readSkills(root)

    expect(read.entries.map((skill) => skill.name)).toEqual(['small'])
    expect(read.problems).toHaveLength(1)
    expect(read.problems[0].name).toBe('big')
    expect(read.problems[0].message).toContain('没有同步')
  })
})

describe('the part a computer holds', () => {
  it('is nothing at all when there are no skills', () => {
    // An empty part on the server would empty the root for the computers that
    // do have skills, so "none here" has to travel as no part.
    expect(skillsPartOf({ entries: [], mtimeMs: 0, problems: [] }, undefined)).toBeUndefined()
  })

  it('carries the server copy of a skill this computer could not read', async () => {
    // Reading a folder that will not open as "a folder with no files in it"
    // would announce every file in it as deleted, so their copy stands instead.
    const root = await tree({ 'alpha/SKILL.md': 'local', 'big/SKILL.md': 'x'.repeat(DIRS_MAX_BYTES + 1) })
    const carried: SkillsPart = {
      skills: [
        { name: 'alpha', files: [{ path: 'SKILL.md', data: Buffer.from('remote').toString('base64') }] },
        { name: 'big', files: [{ path: 'SKILL.md', data: Buffer.from('theirs').toString('base64') }] },
      ],
    }

    const part = skillsPartOf(await readSkills(root), carried)
    expect(part?.skills.map((skill) => skill.name)).toEqual(['alpha', 'big'])
    expect(contentsOf(part, 'alpha')).toEqual({ 'SKILL.md': 'local' })
    expect(contentsOf(part, 'big')).toEqual({ 'SKILL.md': 'theirs' })
  })

  it('defers to the server whole when even the root could not be listed', async () => {
    const root = await tempDir()
    const file = join(root, 'file.txt')
    await writeFile(file, 'x', 'utf8')
    const carried: SkillsPart = {
      skills: [{ name: 'alpha', files: [{ path: 'SKILL.md', data: Buffer.from('theirs').toString('base64') }] }],
    }
    expect(skillsPartOf(await readSkills(file), carried)).toBe(carried)
    // And with nothing on the server either, there is simply nothing to say.
    expect(skillsPartOf(await readSkills(file), undefined)).toBeUndefined()
  })
})

describe('writing the skills back', () => {
  it('puts each skill into its folder under the root, making the folders it needs', async () => {
    const elsewhere = await tree({ 'alpha/SKILL.md': '# alpha', 'alpha/nested/one.txt': 'one' })
    const part = skillsPartOf(await readSkills(elsewhere), undefined) as SkillsPart

    // A restore on a computer that has never held these: the name in the part
    // is the folder that gets written under the root, unchanged.
    const root = await tempDir()
    const write = await writeSkills(root, part, new Set())

    expect(write.changed).toBe(true)
    expect(write.paths).toEqual(['alpha'])
    expect(await readFile(join(root, 'alpha', 'SKILL.md'), 'utf8')).toBe('# alpha')
    expect(await readFile(join(root, 'alpha', 'nested', 'one.txt'), 'utf8')).toBe('one')
  })

  it('reports nothing changed when the bytes are already there', async () => {
    const root = await tree({ 'alpha/SKILL.md': '# alpha' })
    const part = skillsPartOf(await readSkills(root), undefined) as SkillsPart
    expect((await writeSkills(root, part, new Set())).changed).toBe(false)
    expect(await skillsDiffer(root, part, new Set())).toBe(false)
    // ...and says a write would change something the moment one byte differs.
    await writeFile(join(root, 'alpha', 'SKILL.md'), '# changed', 'utf8')
    expect(await skillsDiffer(root, part, new Set())).toBe(true)
  })

  it('never deletes: a file the part does not name stays', async () => {
    const root = await tree({ 'alpha/SKILL.md': '# alpha', 'alpha/by-hand.txt': 'mine' })
    const part: SkillsPart = {
      skills: [{ name: 'alpha', files: [{ path: 'SKILL.md', data: Buffer.from('# alpha').toString('base64') }] }],
    }
    await writeSkills(root, part, new Set())
    expect(await readFile(join(root, 'alpha', 'by-hand.txt'), 'utf8')).toBe('mine')
  })

  it('never writes outside the skill folder', async () => {
    // A carried path is data from another computer, and data that walks upwards
    // would let a restore write anywhere on this one.
    const root = await tempDir()
    const part: SkillsPart = {
      skills: [
        {
          name: 'alpha',
          files: [
            { path: '../escaped.txt', data: Buffer.from('escaped').toString('base64') },
            { path: '/absolute.txt', data: Buffer.from('escaped').toString('base64') },
            // On Windows `..\..\x` is one segment to a `/`-split and two steps
            // up to `join`, so the backslash spelling is caught too.
            { path: '..\\escaped.txt', data: Buffer.from('escaped').toString('base64') },
            { path: 'a/../../escaped.txt', data: Buffer.from('escaped').toString('base64') },
            { path: 'kept/inside.txt', data: Buffer.from('fine').toString('base64') },
          ],
        },
      ],
    }

    await writeSkills(root, part, new Set())
    await expect(readFile(join(root, 'escaped.txt'), 'utf8')).rejects.toThrow()
    expect(await readFile(join(root, 'alpha', 'kept', 'inside.txt'), 'utf8')).toBe('fine')
  })

  it('leaves a name that is not one folder under the root alone, and keeps it in the list', async () => {
    // Dropping it instead would drop it for the computer that can use it, so it
    // stays named here and is simply not written here.
    const root = await tempDir()
    const part: SkillsPart = {
      skills: [
        { name: 'a/b', files: [{ path: 'SKILL.md', data: Buffer.from('deep').toString('base64') }] },
        { name: '../climb', files: [{ path: 'SKILL.md', data: Buffer.from('climb').toString('base64') }] },
      ],
    }

    const write = await writeSkills(root, part, new Set())
    expect(write.changed).toBe(false)
    expect(write.paths).toEqual(['../climb', 'a/b'])
    await expect(readFile(join(root, '..', 'climb', 'SKILL.md'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(root, 'a', 'b', 'SKILL.md'), 'utf8')).rejects.toThrow()
  })

  it('leaves a skill this run could not read exactly as it was', async () => {
    const root = await tree({ 'alpha/SKILL.md': 'the local copy' })
    const part: SkillsPart = {
      skills: [{ name: 'alpha', files: [{ path: 'SKILL.md', data: Buffer.from('theirs').toString('base64') }] }],
    }

    const write = await writeSkills(root, part, new Set(['alpha']))
    expect(write.changed).toBe(false)
    expect(write.paths).toEqual(['alpha'])
    expect(await readFile(join(root, 'alpha', 'SKILL.md'), 'utf8')).toBe('the local copy')
  })

  it('round-trips the skills through the part unchanged', async () => {
    const elsewhere = await tree({ 'alpha/SKILL.md': 'a', 'alpha/b/c.txt': 'c', 'beta/SKILL.md.disabled': 'b' })
    const before = skillsPartOf(await readSkills(elsewhere), undefined) as SkillsPart

    const root = await tempDir()
    await writeSkills(root, before, new Set())
    const after = await readSkills(root)

    expect(skillsPartOf(after, undefined)).toEqual(before)
    expect(after.mtimeMs).toBeGreaterThanOrEqual(0)
  })
})
