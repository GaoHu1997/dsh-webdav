import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAbsolute } from 'node:path'
import { dirsDiffer, dirsPartOf, portableDirsPart, readDirs, writeDirs } from '../src/dirs.js'
import { NotBackupError, open, seal } from '../src/crypto.js'
import type { DirsPart } from '../src/wire.js'

// No test may read or write a real default user directory. Reads are virtual;
// mutations fail before the filesystem even if a path-mode regression occurs.
const fs = vi.hoisted(() => {
  // setup.ts imports harness.ts, which has already loaded dirs through engine.
  // Reset that module cache before installing these filesystem mocks.
  vi.resetModules()
  return {
    stat: vi.fn(),
    readFile: vi.fn(),
    readdir: vi.fn(),
    denyWrite: vi.fn(async () => { throw new Error('A virtual-path test must not mutate the real filesystem') }),
  }
})
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  stat: fs.stat,
  readFile: fs.readFile,
  readdir: fs.readdir,
  mkdir: fs.denyWrite,
  writeFile: fs.denyWrite,
  rename: fs.denyWrite,
}))
afterEach(() => vi.clearAllMocks())

const external = process.platform === 'win32'
  ? 'C:/Users/virtual-other-user/.dsh/AGENTS.md'
  : '/home/virtual-other-user/.dsh/AGENTS.md'
const home = process.platform === 'win32' ? 'C:/virtual-current-dsh' : '/virtual-current-dsh'
const bytes = Buffer.from('literal rules')
const fileInfo = { isFile: () => true, isDirectory: () => false, size: bytes.length, mtimeMs: 1 }

describe('explicit absolute paths versus legacy default-home inference', () => {
  it('marks a new external default-home-looking file as literal on every receiving host', async () => {
    fs.stat.mockResolvedValue(fileInfo)
    fs.readFile.mockResolvedValue(bytes)
    expect(isAbsolute(external)).toBe(true)
    const read = await readDirs([external], home)
    expect(read.problems).toEqual([])
    const part: DirsPart = { dirs: read.entries }
    expect(part.dirs).toEqual([{ path: external, pathMode: 'absolute', kind: 'file', data: bytes.toString('base64'), files: [] }])
    expect(portableDirsPart(part, home)).toEqual(part)
    expect(portableDirsPart(part, undefined)).toEqual(part)
    expect(portableDirsPart(part, `${home}-other-host`)).toEqual(part)
    expect(fs.stat).toHaveBeenCalledWith(external)
  })

  it('seals an actual selected absolute path as v2 and refuses it before old-client I/O', async () => {
    fs.stat.mockResolvedValue(fileInfo)
    fs.readFile.mockResolvedValue(bytes)
    const read = await readDirs([external], home)
    const payload = { dirs: { dirs: read.entries } }
    const sealed = await seal(payload, 'test passphrase')
    const envelope = JSON.parse(new TextDecoder().decode(sealed)) as { version: number }
    expect(envelope.version).toBe(2)
    expect(await open(sealed, 'test passphrase')).toEqual(payload)

    // Released v1 readers reject this header before decrypting or applying rows.
    let legacyMutations = 0
    const legacyClientSync = async (): Promise<unknown> => {
      if (envelope.version !== 1) throw new NotBackupError()
      const decoded = await open(sealed, 'test passphrase')
      legacyMutations += 1 // Reached only after decrypting, before apply or DAV PUT.
      return decoded
    }
    await expect(legacyClientSync()).rejects.toBeInstanceOf(NotBackupError)
    expect(legacyMutations).toBe(0)
    expect(fs.denyWrite).not.toHaveBeenCalled()
  })

  it('marks a new directory the same way without changing its file representation', async () => {
    fs.stat.mockResolvedValue({ ...fileInfo, isFile: () => false, isDirectory: () => true })
    fs.readdir.mockResolvedValue([])
    const read = await readDirs([external], home)
    expect(read.problems).toEqual([])
    expect(read.entries).toEqual([{ path: external, pathMode: 'absolute', files: [] }])
    expect(portableDirsPart({ dirs: read.entries }, home).dirs[0]?.path).toBe(external)
  })

  it('keeps a new explicit absolute file literal even when this host cannot report a DSH home', async () => {
    fs.stat.mockResolvedValue(fileInfo)
    fs.readFile.mockResolvedValue(bytes)
    const part: DirsPart = { dirs: (await readDirs([external])).entries }
    expect(part.dirs[0]?.pathMode).toBe('absolute')
    expect(portableDirsPart(part, home).dirs[0]?.path).toBe(external)
  })

  it('binds a missing explicit external selection before inferring the old default-home row', async () => {
    fs.stat.mockRejectedValue(Object.assign(new Error('virtual missing target'), { code: 'ENOENT' }))
    const read = await readDirs([external], home)
    expect(read.problems).toEqual([{ path: external, message: '这台电脑上还没有这个目录或文件', missing: true }])
    const legacy: DirsPart = { dirs: [{ path: external, kind: 'file', data: bytes.toString('base64'), files: [] }] }
    const literal = portableDirsPart(legacy, home, [external])
    expect(literal.dirs).toEqual([{ ...legacy.dirs[0], pathMode: 'absolute' }])
    expect(dirsPartOf(read, legacy)).toEqual(literal)
    if (process.platform === 'win32') {
      expect(portableDirsPart(legacy, home, [external.replaceAll('/', '\\').toUpperCase()])).toEqual(literal)
    }
    expect(portableDirsPart(legacy, home).dirs[0]?.path).toBe('~/AGENTS.md')
    expect(fs.denyWrite).not.toHaveBeenCalled()
  })

  it('protects the explicitly selected external target rather than inferring a different skip target', async () => {
    const part: DirsPart = { dirs: [{ path: external, pathMode: 'absolute', kind: 'file', data: bytes.toString('base64'), files: [] }] }
    const skipped = new Set([external])
    expect(await dirsDiffer(part, skipped, home)).toBe(false)
    expect(await writeDirs(part, skipped, home)).toEqual({ changed: false, paths: [external] })
    expect(fs.readFile).not.toHaveBeenCalled()
    expect(fs.denyWrite).not.toHaveBeenCalled()
  })
})
