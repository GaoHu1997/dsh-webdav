/**
 * The extra directories: reading a tree into the `dirs` part, and writing it back.
 *
 * The profile parts are files this plugin already knows the shape of; a
 * directory is different, and the tests are about the three places that shows:
 * a tree is walked rather than parsed, its path travels in the data, and writing
 * it is additive. Each of those has an accident behind it — half a directory
 * pushed, a path invented on the other computer, a file deleted everywhere
 * because one machine could not see it — and those are what is checked here.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DIRS_MAX_BYTES, dirsDiffer, dirsPartOf, expandHome, homeRelative, normaliseDirs, readDirs, writeDirs } from '../src/dirs.ts'
import { cleanUp, tempDir } from './harness.ts'
import type { DirsPart } from '../src/wire.ts'

afterEach(async () => {
  await cleanUp()
})

/** A directory holding the given files, keyed by a `/`-separated path. */
async function tree(files: Record<string, string>): Promise<string> {
  const root = await tempDir()
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, ...path.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, text, 'utf8')
  }
  return root
}

/** The files of one carried directory, as path → text. */
function contents(part: DirsPart | undefined, index = 0): Record<string, string> {
  const dir = part?.dirs[index]
  expect(dir).toBeDefined()
  const out: Record<string, string> = {}
  for (const file of dir?.files ?? []) out[file.path] = Buffer.from(file.data, 'base64').toString('utf8')
  return out
}

/** The files carried for one named directory, whatever its place in the list. */
function contentsOf(part: DirsPart | undefined, path: string): Record<string, string> {
  const index = (part?.dirs ?? []).findIndex((dir) => dir.path === path)
  expect(index).toBeGreaterThanOrEqual(0)
  return contents(part, index)
}

describe('reading a configured directory', () => {
  it('carries every file, with `/`-separated names and the bytes in base64', async () => {
    const root = await tree({ 'notes.md': '# hello', 'nested/deep/one.txt': 'one', 'nested/two.txt': 'two' })
    const read = await readDirs([root])

    expect(read.problems).toEqual([])
    expect(read.entries).toHaveLength(1)
    expect(read.entries[0].path).toBe(root)
    // The names are relative to the directory and `/`-separated on every
    // platform, because the part travels and a Windows `\` would arrive as a
    // filename on the other computer.
    expect(contents(dirsPartOf(read, undefined))).toEqual({
      'nested/deep/one.txt': 'one',
      'nested/two.txt': 'two',
      'notes.md': '# hello',
    })
    expect(read.mtimeMs).toBeGreaterThan(0)
  })

  it('walks nested folders, and keeps the newest file stamp for the merge', async () => {
    const root = await tree({ 'a/b/c/deep.txt': 'deep' })
    const read = await readDirs([root])
    expect(contents(dirsPartOf(read, undefined))).toEqual({ 'a/b/c/deep.txt': 'deep' })
    expect(read.mtimeMs).toBeCloseTo((await readDirs([root])).mtimeMs, -1)
  })

  it('skips node_modules and .git, and says nothing about them', async () => {
    // A plugin's dependencies are installed on each computer, and a repository
    // there has an owner of its own: carrying either would be carrying somebody
    // else's business into a sealed file.
    const root = await tree({
      'keep.txt': 'keep',
      'node_modules/pkg/index.js': 'module.exports = 1',
      '.git/config': '[core]',
    })
    const read = await readDirs([root])
    expect(contents(dirsPartOf(read, undefined))).toEqual({ 'keep.txt': 'keep' })
    expect(read.problems).toEqual([])
  })

  it('reports a directory that is not there as a problem, not as an empty directory', async () => {
    // The difference matters: "empty" would be pushed as a deletion of every
    // file in it, and a disconnected drive would empty everybody else's copy.
    const gone = join(await tempDir(), 'not-there')
    const read = await readDirs([gone])

    expect(read.entries).toEqual([])
    expect(read.problems).toHaveLength(1)
    expect(read.problems[0].path).toBe(gone)
    expect(read.problems[0].message).not.toBe('')
    // Marked absent, which is what lets a restore create it again: a directory
    // that is merely not here is written into, one that could not be read is not.
    expect(read.problems[0].missing).toBe(true)
  })

  it('refuses a path that is not absolute on this computer', async () => {
    const read = await readDirs(['some/other/computer/folder'])
    expect(read.entries).toEqual([])
    expect(read.problems[0].path).toBe('some/other/computer/folder')
    expect(read.problems[0].message).toContain('不是绝对路径')
  })

  it('resolves a ~ path against this computer DSH home, and carries the name as written', async () => {
    const home = await tempDir('dirs-home-')
    await mkdir(join(home, 'plugin'), { recursive: true })
    await writeFile(join(home, 'plugin', 'state.json'), '{"ok":true}', 'utf8')

    const read = await readDirs(['~/plugin'], home)
    expect(read.problems).toEqual([])
    expect(read.entries).toHaveLength(1)
    // The path that travels is the name as it was written, not this machine's
    // spelling of it: the other computer resolves the same name against its own
    // home.
    expect(read.entries[0].path).toBe('~/plugin')
    expect(read.entries[0].files).toHaveLength(1)
  })

  it('reports a ~ path on a machine that knows no DSH home, rather than guessing one', async () => {
    const read = await readDirs(['~/plugin'], undefined)
    expect(read.entries).toEqual([])
    expect(read.problems[0].path).toBe('~/plugin')
    expect(read.problems[0].message).toContain('DSH 主目录')
    // Absent would let a restore create it; unresolvable must not.
    expect(read.problems[0].missing).toBeUndefined()
  })

  it('treats ~user as an ordinary relative path, not a home', () => {
    expect(homeRelative('~')).toBe(true)
    expect(homeRelative('~/plugin')).toBe(true)
    expect(homeRelative('~\\plugin')).toBe(true)
    expect(homeRelative('~user/plugin')).toBe(false)
    expect(homeRelative('C:\\~')).toBe(false)
    expect(homeRelative('')).toBe(false)
  })

  it('expands ~ to the home itself, with or without a separator', () => {
    expect(expandHome('~', 'H:\\dsh')).toBe('H:\\dsh')
    expect(expandHome('~/plugin', 'H:\\dsh')).toBe(join('H:\\dsh', 'plugin'))
    expect(expandHome('~\\plugin', 'H:\\dsh')).toBe(join('H:\\dsh', 'plugin'))
    expect(expandHome('C:\\plain', 'H:\\dsh')).toBe('C:\\plain')
    expect(expandHome('~/plugin', undefined)).toBeUndefined()
    expect(expandHome('~/plugin', '  ')).toBeUndefined()
  })

  it('refuses a tree over the size cap as a whole, rather than carrying half of it', async () => {
    const root = await tree({ 'big.bin': 'x'.repeat(DIRS_MAX_BYTES + 1) })
    const read = await readDirs([root])
    expect(read.entries).toEqual([])
    expect(read.problems[0].path).toBe(root)
    expect(read.problems[0].message).toContain('没有同步')
  })
})

describe('the part a computer holds', () => {
  it('is nothing at all when no directory is configured', () => {
    // An empty part on the server would empty the directory for the computers
    // that do sync one, so "no directories" has to travel as no part.
    expect(dirsPartOf({ entries: [], mtimeMs: 0, problems: [] }, undefined)).toBeUndefined()
  })

  it('carries the server copy of a directory this computer could not read', async () => {
    const here = await tree({ 'local.txt': 'local' })
    const elsewhere = '/another/computer/folder'
    const carried: DirsPart = {
      dirs: [{ path: elsewhere, files: [{ path: 'remote.txt', data: Buffer.from('remote').toString('base64') }] }],
    }

    const part = dirsPartOf(await readDirs([here, elsewhere]), carried)
    expect(part?.dirs.map((dir) => dir.path)).toEqual([here, elsewhere].sort())
    // The one that was read is this computer's; the one that was not is theirs.
    expect(contentsOf(part, here)).toEqual({ 'local.txt': 'local' })
    expect(contentsOf(part, elsewhere)).toEqual({ 'remote.txt': 'remote' })
  })

  it('keeps one list order, so the same directories hash the same everywhere', () => {
    expect(normaliseDirs([' C:\\b ', 'C:\\a', 'C:\\b', '', 'C:\\a'])).toEqual(['C:\\a', 'C:\\b'])
    expect(normaliseDirs(undefined)).toEqual([])
    expect(normaliseDirs(['', '  '])).toEqual([])
  })
})

describe('writing the part back', () => {
  it('puts the files into the same directory, making the folders it needs', async () => {
    const root = await tree({ 'notes.md': '# hello', 'nested/one.txt': 'one' })
    const part = dirsPartOf(await readDirs([root]), undefined)
    expect(part).toBeDefined()

    // A restore on a computer that has never held this directory: the path in
    // the part is the path that gets written, unchanged.
    await rm(root, { recursive: true, force: true })
    const write = await writeDirs(part as DirsPart, new Set())

    expect(write.changed).toBe(true)
    expect(write.paths).toEqual([root])
    expect(await readFile(join(root, 'notes.md'), 'utf8')).toBe('# hello')
    expect(await readFile(join(root, 'nested', 'one.txt'), 'utf8')).toBe('one')
  })

  it('reports nothing changed when the bytes are already there', async () => {
    const root = await tree({ 'notes.md': '# hello' })
    const part = dirsPartOf(await readDirs([root]), undefined) as DirsPart
    expect((await writeDirs(part, new Set())).changed).toBe(false)
  })

  it('never writes outside the directory a carried file claims', async () => {
    // A carried path is data from another computer, and data that walks upwards
    // would let a restore write anywhere on this one.
    const root = await tempDir()
    const outside = join(root, 'outside.txt')
    const part: DirsPart = {
      dirs: [
        {
          path: join(root, 'folder'),
          files: [
            { path: '../outside.txt', data: Buffer.from('escaped').toString('base64') },
            { path: '/absolute.txt', data: Buffer.from('escaped').toString('base64') },
          ],
        },
      ],
    }

    const write = await writeDirs(part, new Set())
    expect(write.changed).toBe(false)
    await expect(readFile(outside, 'utf8')).rejects.toThrow()
  })

  it('never writes outside the directory through a backslash either', async () => {
    // On Windows `..\..\x` is one segment to a `/`-split and two steps up to
    // `join`, so a path spelled with backslashes walked out of the directory
    // while looking harmless. On other platforms a backslash is a legal
    // character in a file name, so the only thing to check there is the seal.
    const root = await tempDir()
    const folder = join(root, 'folder')
    await mkdir(folder, { recursive: true })
    const outside = join(root, 'outside.txt')
    const part: DirsPart = {
      dirs: [
        {
          path: folder,
          files: [
            { path: '..\\outside.txt', data: Buffer.from('escaped').toString('base64') },
            { path: '..\\..\\outside.txt', data: Buffer.from('escaped').toString('base64') },
            // One separator of each: caught by the `/` pass on every platform.
            { path: 'a/../../outside.txt', data: Buffer.from('escaped').toString('base64') },
          ],
        },
      ],
    }

    await writeDirs(part, new Set())
    await expect(readFile(outside, 'utf8')).rejects.toThrow()
  })

  it('leaves a directory this run could not read exactly as it was', async () => {
    const root = await tree({ 'keep.txt': 'the local copy' })
    const part: DirsPart = {
      dirs: [{ path: root, files: [{ path: 'keep.txt', data: Buffer.from('theirs').toString('base64') }] }],
    }

    const write = await writeDirs(part, new Set([root]))
    expect(write.changed).toBe(false)
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('the local copy')
  })

  it('leaves a path that is not absolute on this computer alone, and keeps it in the list', async () => {
    // Dropping it instead would delete it for the computer that can use it, so
    // it stays named here and is simply not written here.
    const part: DirsPart = {
      dirs: [{ path: 'another/computer/folder', files: [{ path: 'a.txt', data: Buffer.from('a').toString('base64') }] }],
    }

    const write = await writeDirs(part, new Set())
    expect(write.changed).toBe(false)
    expect(write.paths).toEqual(['another/computer/folder'])
  })

  it('writes a ~ path under this computer own DSH home, keeping the name in the list', async () => {
    const home = await tempDir('dirs-home-')
    const part: DirsPart = {
      dirs: [{ path: '~/plugin', files: [{ path: 'state.json', data: Buffer.from('{"ok":1}').toString('base64') }] }],
    }

    const write = await writeDirs(part, new Set(), home)
    expect(write.changed).toBe(true)
    expect(write.paths).toEqual(['~/plugin'])
    expect(await readFile(join(home, 'plugin', 'state.json'), 'utf8')).toBe('{"ok":1}')
  })

  it('leaves a ~ path alone when no DSH home is known, and keeps it in the list', async () => {
    const part: DirsPart = {
      dirs: [{ path: '~/plugin', files: [{ path: 'state.json', data: Buffer.from('{}').toString('base64') }] }],
    }

    const write = await writeDirs(part, new Set(), undefined)
    expect(write.changed).toBe(false)
    expect(write.paths).toEqual(['~/plugin'])
  })

  it('sees a ~ path differing when the home copy does not match the part', async () => {
    const home = await tempDir('dirs-home-')
    await mkdir(join(home, 'plugin'), { recursive: true })
    await writeFile(join(home, 'plugin', 'state.json'), '{"old":1}', 'utf8')
    const part: DirsPart = {
      dirs: [{ path: '~/plugin', files: [{ path: 'state.json', data: Buffer.from('{"new":1}').toString('base64') }] }],
    }

    expect(await dirsDiffer(part, new Set(), home)).toBe(true)
    await writeDirs(part, new Set(), home)
    expect(await dirsDiffer(part, new Set(), home)).toBe(false)
  })

  it('round-trips a directory through the part unchanged', async () => {
    const root = await tree({ 'a.txt': 'a', 'b/c.txt': 'c', 'empty.txt': '' })
    const before = dirsPartOf(await readDirs([root]), undefined) as DirsPart

    await rm(root, { recursive: true, force: true })
    await writeDirs(before, new Set())
    const after = dirsPartOf(await readDirs([root]), undefined)

    expect(after).toEqual(before)
  })
})
