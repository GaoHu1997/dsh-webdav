import { mkdir, readFile, stat, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dirsDiffer, dirsPartOf, expandHome, portableDirsPart, readDirs, writeDirs } from '../src/dirs.js'
import type { DirsPart } from '../src/wire.js'
import { cleanUp, tempDir } from './harness.js'

const data = (text: string): string => Buffer.from(text).toString('base64')
const directory = (path: string, names: Record<string, string>): DirsPart => ({
  dirs: [{ path, files: Object.entries(names).map(([path, text]) => ({ path, data: data(text) })) }],
})
afterEach(cleanUp)

describe('portable directory data and restore boundaries', () => {
  it('migrates an old Windows directory before restoring its nested files under the actual home', async () => {
    const home = await tempDir('portable-directory-')
    const legacy = directory('C:/Users/alice/.dsh/notes', { 'a.txt': 'a', 'nested/b.txt': 'b' })
    const part = portableDirsPart(legacy, home)
    // Assert the address before I/O, so a regression cannot write to a real user.
    expect(part.dirs.map(row => row.path)).toEqual(['~/notes'])
    expect(await dirsDiffer(part, new Set(), home)).toBe(true)
    expect(await writeDirs(part, new Set(), home)).toEqual({ changed: true, paths: ['~/notes'] })
    expect(await readFile(join(home, 'notes', 'a.txt'), 'utf8')).toBe('a')
    expect(await readFile(join(home, 'notes', 'nested', 'b.txt'), 'utf8')).toBe('b')
    expect(await dirsDiffer(part, new Set(), home)).toBe(false)
  })

  it('unions disjoint directory aliases and deduplicates identical single-file aliases', () => {
    const part: DirsPart = { dirs: [
      ...directory('C:/Users/alice/.dsh/notes', { 'a.txt': 'a' }).dirs,
      ...directory('~/notes', { 'b.txt': 'b', 'a.txt': 'a' }).dirs,
      { path: '/home/alice/.dsh/AGENTS.md', kind: 'file', data: data('rules'), files: [] },
      { path: '~/AGENTS.md', kind: 'file', data: data('rules'), files: [] },
    ] }
    expect(portableDirsPart(part).dirs).toEqual([
      { path: '~/AGENTS.md', kind: 'file', data: data('rules'), files: [] },
      { path: '~/notes', files: [{ path: 'a.txt', data: data('a') }, { path: 'b.txt', data: data('b') }] },
    ])
  })

  it('refuses conflicting aliases rather than silently discarding either copy', () => {
    expect(() => portableDirsPart({ dirs: [
      ...directory('C:/Users/alice/.dsh/notes', { 'a.txt': 'old' }).dirs,
      ...directory('~/notes', { 'a.txt': 'new' }).dirs,
    ] })).toThrow('附加路径迁移后内容冲突')
    expect(() => portableDirsPart({ dirs: [
      { path: '/home/alice/.dsh/a', kind: 'file', data: data('old'), files: [] },
      { path: '~/a', kind: 'file', data: data('new'), files: [] },
    ] })).toThrow('附加路径迁移后内容冲突')
    expect(() => portableDirsPart({ dirs: [
      ...directory('C:/Users/alice/.dsh/a', {}).dirs,
      { path: '~/a', kind: 'file', data: data('file'), files: [] },
    ] })).toThrow('附加路径迁移后内容冲突')
  })

  it('carries the server bytes for a missing absolute local selection by portable identity', async () => {
    const home = await tempDir('portable-missing-')
    const read = await readDirs([join(home, 'notes')], home)
    expect(read.problems).toEqual([{ path: '~/notes', message: '这台电脑上还没有这个目录或文件', missing: true }])
    expect(dirsPartOf(read, directory('C:/Users/alice/.dsh/notes', { 'a.txt': 'keep' })))
      .toEqual(directory('~/notes', { 'a.txt': 'keep' }))
  })

  it('an absolute unreadable-path alias cannot bypass the skip set', async () => {
    const home = await tempDir('portable-skip-')
    await mkdir(join(home, 'notes'))
    await writeFile(join(home, 'notes', 'a.txt'), 'local')
    const part = directory('~/notes', { 'a.txt': 'remote' })
    const skip = new Set([join(home, 'notes')])
    expect(await dirsDiffer(part, skip, home)).toBe(false)
    expect((await writeDirs(part, skip, home)).changed).toBe(false)
    expect(await readFile(join(home, 'notes', 'a.txt'), 'utf8')).toBe('local')
  })

  it.skipIf(process.platform !== 'win32')('protects the same Windows file when its portable suffix differs in case', async () => {
    const home = await tempDir('portable-case-skip-')
    const local = join(home, 'Blocked.bin')
    const size = 8 * 1024 * 1024 + 1
    await writeFile(local, '')
    await truncate(local, size)
    await mkdir(join(home, 'notes'))
    const read = await readDirs(['~/Blocked.bin', '~/notes'], home)
    expect(read.entries.map(row => row.path)).toEqual(['~/notes'])
    expect(read.problems.map(row => row.path)).toEqual(['~/Blocked.bin'])
    const part = portableDirsPart({ dirs: [{ path: 'C:/Users/old/.dsh/blocked.bin', kind: 'file', data: data('remote'), files: [] }] }, home)
    expect(part.dirs[0]?.path).toBe('~/blocked.bin')
    const skip = new Set(read.problems.map(row => row.path))
    expect(await dirsDiffer(part, skip, home)).toBe(false)
    expect((await writeDirs(part, skip, home)).changed).toBe(false)
    expect((await stat(local)).size).toBe(size)
  })

  it('protects a skipped file carried inside a broader directory row', async () => {
    const home = await tempDir('portable-inner-skip-')
    await writeFile(join(home, 'blocked.txt'), 'local')
    const part = directory('~', { 'blocked.txt': 'remote' })
    const skip = new Set(['~/blocked.txt'])
    expect(await dirsDiffer(part, skip, home)).toBe(false)
    expect((await writeDirs(part, skip, home)).changed).toBe(false)
    expect(await readFile(join(home, 'blocked.txt'), 'utf8')).toBe('local')
  })

  it('protects skipped descendants without blocking a similarly prefixed neighbor', async () => {
    const home = await tempDir('portable-subtree-skip-')
    await mkdir(join(home, 'notes', 'nested'), { recursive: true })
    await mkdir(join(home, 'notes-other'))
    await writeFile(join(home, 'notes', 'nested', 'a.txt'), 'local')
    await writeFile(join(home, 'notes-other', 'a.txt'), 'local')
    const part: DirsPart = { dirs: [
      ...directory('~/notes/nested', { 'a.txt': 'remote' }).dirs,
      ...directory('~/notes-other', { 'a.txt': 'remote' }).dirs,
    ] }
    const skip = new Set(['~/notes'])
    expect(await dirsDiffer(part, skip, home)).toBe(true)
    expect((await writeDirs(part, skip, home)).changed).toBe(true)
    expect(await readFile(join(home, 'notes', 'nested', 'a.txt'), 'utf8')).toBe('local')
    expect(await readFile(join(home, 'notes-other', 'a.txt'), 'utf8')).toBe('remote')
  })

  it('never restores a portable escape into the parent of the DSH home', async () => {
    const root = await tempDir('portable-escape-')
    const home = join(root, 'home')
    await mkdir(home)
    await writeFile(join(root, 'outside'), 'keep')
    expect(expandHome('~/../outside', home)).toBeUndefined()
    expect(expandHome('~\\..\\outside', home)).toBeUndefined()
    const part: DirsPart = { dirs: [{ path: '~/../outside', kind: 'file', data: data('overwrite'), files: [] }] }
    expect(await dirsDiffer(part, new Set(), home)).toBe(false)
    expect((await writeDirs(part, new Set(), home)).changed).toBe(false)
    expect(await readFile(join(root, 'outside'), 'utf8')).toBe('keep')
  })
})
