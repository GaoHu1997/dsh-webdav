/**
 * Path identity migrations must not manufacture edits or lose a carried row.
 * All real filesystem reads and writes stay under one tempDir per fixture.
 * Legacy default-home strings live only in sealed FakeDav payloads; guarded
 * directory-I/O boundaries fail before a regression can touch a real user home.
 */

import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { open, seal, sum } from '../src/crypto.ts'
import { homeRelative } from '../src/dir-path.ts'
import * as directoryFiles from '../src/dirs.ts'
import { engineFor, hashesOf, pathsOf, preview, sync, type Engine } from '../src/engine.ts'
import type { ResolvedPaths } from '../src/paths.ts'
import { loadState, remember, saveState } from '../src/state.ts'
import {
  BUNDLE_APP,
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  type Bundle,
  type DirsPart,
  type DirSpec,
  type PartHashes,
  type PatchPart,
} from '../src/wire.ts'
import { FakeDav } from './fake-dav.ts'
import { cleanUp, configFor, tempDir } from './harness.ts'

const PASSPHRASE = 'a passphrase'
const FILE_PATH = '/dav/dsh-webdav/dsh-profile.prop'
const OLD_REMOTE_CREATED = '2026-11-01T00:00:00.000Z'
const LOCAL_NEWER = new Date('2026-11-03T00:00:00.000Z')
const LOCAL_OLDER = new Date('2026-11-02T00:00:00.000Z')
const NEW_REMOTE_CREATED = '2026-11-04T00:00:00.000Z'

// The context marker is private state metadata, not a new bundle field. Keep
// this fixture compatible with the public PartHashes view while deleting it.
type ScopedHashes = PartHashes & { dirsHome?: string }

let stop: (() => void) | undefined

afterEach(async () => {
  stop?.()
  stop = undefined
  vi.restoreAllMocks()
  await cleanUp()
})

function serve(): FakeDav {
  const dav = new FakeDav({})
  dav.seedCollection('/dav/dsh-webdav')
  stop = dav.use()
  return dav
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

function fileRow(path: string, text: string): DirSpec {
  return { path, kind: 'file', data: base64(text), files: [] }
}

function patchPart(choice: string): PatchPart {
  return { entries: [{ id: 'path-migration-test', name: 'fixture-only-plugin', config: { choice } }] }
}

function patchText(choice: string): string {
  return `- id: path-migration-test\n  name: fixture-only-plugin\n  config:\n    choice: ${JSON.stringify(choice)}\n`
}

function bundle(dirs: DirsPart, choice = 'server-first'): Bundle {
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    created: OLD_REMOTE_CREATED,
    app: BUNDLE_APP,
    patch: patchPart(choice),
    dirs,
  }
}

async function readRemote(dav: FakeDav): Promise<Bundle> {
  const bytes = dav.files.get(FILE_PATH)?.data
  if (bytes === undefined) throw new Error('The fixture server has no backup')
  return await open(bytes, PASSPHRASE) as Bundle
}

/** Guard the same four boundaries as the existing legacy two-machine fixture. */
function guardDirectoryIo(root: string) {
  const expand = directoryFiles.expandHome
  const read = directoryFiles.readDirs
  const differ = directoryFiles.dirsDiffer
  const write = directoryFiles.writeDirs

  const owned = (path: string): void => {
    const slash = path.replace(/\\/g, '/')
    if (/^[a-z]:\/users\/(?:alice|bob)\/\.dsh(?:\/|$)/i.test(slash)) {
      throw new Error('A legacy remote user home must never reach filesystem access')
    }
    if (homeRelative(path)) return
    if (!isAbsolute(path)) throw new Error(`Unowned directory-I/O path: ${path}`)
    const tail = relative(resolve(root), resolve(path))
    if (tail === '..' || tail.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(tail)) {
      throw new Error(`Directory I/O escaped the fixture tempDir: ${path}`)
    }
  }

  const targets = (paths: readonly string[], home: string | undefined, writing = false): void => {
    if (home !== undefined) owned(home)
    for (const path of paths) {
      owned(path)
      const target = expand(path, home)
      if (target !== undefined) owned(target)
      else if (writing) throw new Error('An unresolved home-relative path must not be applied')
    }
  }

  const expandSpy = vi.spyOn(directoryFiles, 'expandHome').mockImplementation((path, home) => {
    targets([path], home)
    return expand(path, home)
  })
  const readSpy = vi.spyOn(directoryFiles, 'readDirs').mockImplementation((paths, home, ...args) => {
    targets(paths, home)
    return read(paths, home, ...args)
  })
  const differSpy = vi.spyOn(directoryFiles, 'dirsDiffer').mockImplementation((part, skip, home) => {
    targets(part.dirs.map(dir => dir.path), home, true)
    return differ(part, skip, home)
  })
  const writeSpy = vi.spyOn(directoryFiles, 'writeDirs').mockImplementation((part, skip, home) => {
    targets(part.dirs.map(dir => dir.path), home, true)
    return write(part, skip, home)
  })
  return { expand: expandSpy, read: readSpy, differ: differSpy, write: writeSpy }
}

interface FixtureOptions {
  home?: boolean
  dirs?: string[] | ((root: string) => string[])
  dirsEnabled?: boolean
}

interface Fixture {
  root: string
  home: string
  external: string
  agents: string
  paths: ResolvedPaths
  engine: Engine
  dav: FakeDav
  io: ReturnType<typeof guardDirectoryIo>
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await tempDir('path-migration-regression-')
  const profile = join(root, 'profile')
  const home = join(root, 'home')
  const external = join(root, 'external', 'readable.txt')
  await mkdir(profile, { recursive: true })
  await mkdir(home, { recursive: true })
  await mkdir(dirname(external), { recursive: true })
  await writeFile(join(profile, 'cordis.patch.yml'), patchText('local-first'), 'utf8')
  await writeFile(join(profile, 'package.json'), '{"private":true}', 'utf8')
  const paths = options.home === false ? pathsOf(profile) : pathsOf(profile, home)
  const dirs = typeof options.dirs === 'function' ? options.dirs(root) : options.dirs ?? ['~/AGENTS.md']
  const config = configFor({
    passphrase: PASSPHRASE,
    models: false,
    plugins: false,
    patch: true,
    keys: false,
    mcp: false,
    skills: false,
    dirsEnabled: options.dirsEnabled ?? true,
    dirs,
  })
  const io = guardDirectoryIo(root)
  const dav = serve()
  return { root, home, external, agents: join(home, 'AGENTS.md'), paths, engine: engineFor(paths, config), dav, io }
}

function changedFile(source: Bundle, text: string, created: string, path?: string): Bundle {
  const row = source.dirs?.dirs[0]
  if (row === undefined || source.dirs?.dirs.length !== 1) throw new Error('Expected one fixture file row')
  return {
    ...source,
    created,
    dirs: { ...source.dirs, dirs: [{ ...row, ...(path === undefined ? {} : { path }), data: base64(text) }] },
  }
}

/** Build a genuine successful baseline, then change only its stored path spelling. */
async function legacyBaseline(): Promise<Fixture & { rawA: Bundle; rawHash: string }> {
  const f = await fixture()
  await writeFile(f.agents, 'A', 'utf8')
  expect((await sync(f.engine)).pushed).toBe(true)
  const portableA = await readRemote(f.dav)
  expect(portableA.dirs?.dirs).toEqual([fileRow('~/AGENTS.md', 'A')])
  const rawA = changedFile(portableA, 'A', portableA.created, f.agents)
  const rawHash = hashesOf({ dirs: rawA.dirs }).dirs
  if (rawHash === undefined) throw new Error('Expected the raw fixture dirs hash')
  expect(rawHash).not.toBe(hashesOf({ dirs: portableA.dirs }).dirs)
  const bytesA = await seal(rawA, PASSPHRASE)
  const seeded = f.dav.seed(FILE_PATH, bytesA)
  await remember(f.paths, bytesA)
  const state = await loadState(f.paths)
  if (state.local === undefined || state.remote === undefined) throw new Error('Expected a completed fixture baseline')
  state.sum = sum(bytesA)
  state.server = { ...state.server, etag: seeded.etag }
  state.local = { ...state.local, dirs: rawHash }
  state.remote = { ...state.remote, dirs: rawHash }
  delete (state.local as ScopedHashes).dirsHome
  delete (state.remote as ScopedHashes).dirsHome
  await saveState(f.paths, state)
  const oldState = await loadState(f.paths)
  expect((oldState.local as ScopedHashes).dirsHome).toBeUndefined()
  expect((oldState.remote as ScopedHashes).dirsHome).toBeUndefined()
  expect(oldState.local?.dirs).toBe(rawHash)
  expect(oldState.remote?.dirs).toBe(rawHash)
  return { ...f, rawA, rawHash }
}

describe('portable extra-path migration regressions', () => {
  it('defers all mixed dirs with unknown home without dropping raw remote rows on repeated syncs', async () => {
    const f = await fixture({ home: false, dirs: root => ['~/notes', join(root, 'external', 'readable.txt')] })
    expect(f.paths.homeDir).toBeUndefined()
    await writeFile(f.external, 'external A', 'utf8')
    const rawDirs: DirsPart = { dirs: [
      { path: 'C:/Users/alice/.dsh/notes', files: [{ path: 'notes.md', data: base64('server notes') }] },
      fileRow(f.external, 'external A'),
    ] }
    f.dav.seed(FILE_PATH, await seal(bundle(rawDirs), PASSPHRASE))

    const first = await sync(f.engine)
    expect(first.here).toContain('patch')
    expect(first.here).not.toContain('dirs')
    expect((await readRemote(f.dav)).dirs).toEqual(rawDirs)
    await sync(f.engine, { force: true })
    expect((await readRemote(f.dav)).dirs).toEqual(rawDirs)

    await writeFile(f.paths.patchFile, patchText('local-later'), 'utf8')
    const later = await sync(f.engine)
    expect(later.there).toContain('patch')
    const remote = await readRemote(f.dav)
    expect(remote.patch).toEqual(patchPart('local-later'))
    expect(remote.dirs).toEqual(rawDirs)
    expect(await readFile(f.external, 'utf8')).toBe('external A')
    await expect(readFile(join(f.home, 'notes', 'notes.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.io.differ).not.toHaveBeenCalled()
    expect(f.io.write).not.toHaveBeenCalled()
  })

  it('restores missing portable files on the first sync after an unknown home becomes available', async () => {
    const f = await fixture({ home: false })
    const rawDirs: DirsPart = { dirs: [fileRow('~/AGENTS.md', 'server A')] }
    f.dav.seed(FILE_PATH, await seal(bundle(rawDirs), PASSPHRASE))
    expect((await sync(f.engine)).here).not.toContain('dirs')
    await expect(readFile(f.agents)).rejects.toMatchObject({ code: 'ENOENT' })

    const resumed = engineFor(pathsOf(f.paths.profileDir, f.home), f.engine.config)
    const restored = await sync(resumed)
    expect(restored.here).toContain('dirs')
    expect(await readFile(f.agents, 'utf8')).toBe('server A')
    expect((await readRemote(f.dav)).dirs).toEqual(rawDirs)
    expect((await sync(resumed)).pushed).toBe(false)
  })

  it('still syncs an owned external-only path when the DSH home is unknown', async () => {
    const f = await fixture({ home: false, dirs: root => [join(root, 'external', 'readable.txt')] })
    expect(f.paths.homeDir).toBeUndefined()
    await writeFile(f.external, 'external A', 'utf8')
    expect((await sync(f.engine)).pushed).toBe(true)
    expect((await readRemote(f.dav)).dirs?.dirs).toEqual([fileRow(f.external, 'external A')])

    await writeFile(f.external, 'external B', 'utf8')
    const uploaded = await sync(f.engine)
    expect(uploaded.there).toContain('dirs')
    expect(uploaded.pushed).toBe(true)
    const remoteB = await readRemote(f.dav)
    expect(remoteB.dirs?.dirs).toEqual([fileRow(f.external, 'external B')])

    f.dav.seed(FILE_PATH, await seal(changedFile(remoteB, 'external C', NEW_REMOTE_CREATED), PASSPHRASE))
    expect((await sync(f.engine)).here).toContain('dirs')
    expect(await readFile(f.external, 'utf8')).toBe('external C')
    expect((await readRemote(f.dav)).dirs?.dirs).toEqual([fileRow(f.external, 'external C')])
  })

  it.each(['absolute', 'future-unknown'])('rejects an invalid path-mode row before directory I/O: %s', async pathMode => {
    const f = await fixture()
    // Deliberately bypass static shape constraints to test encrypted input validation.
    const malformed = { ...bundle({ dirs: [] }), dirs: { dirs: [{ ...fileRow('~/AGENTS.md', 'invalid'), pathMode }] } }
    const bytes = await seal(malformed as unknown as Bundle, PASSPHRASE)
    f.dav.seed(FILE_PATH, bytes)
    const putCount = f.dav.pathsFor('PUT').length
    await expect(sync(f.engine)).rejects.toThrow('服务器上的文件是一份读不了的 dsh 同步备份：其中「dirs」这一份的形状不是本插件写出来的')
    await expect(readFile(f.agents)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.dav.files.get(FILE_PATH)?.data).toEqual(bytes)
    expect(f.dav.pathsFor('PUT')).toHaveLength(putCount)
    expect(f.io.write).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'disabled', dirsEnabled: false, dirs: ['~/notes'] },
    { name: 'empty', dirsEnabled: true, dirs: [] },
    { name: 'unreadable', dirsEnabled: true, dirs: ['~/../outside'] },
  ])('carries conflicting legacy aliases untouched while other parts sync when dirs are $name', async ({ dirs, dirsEnabled }) => {
    const f = await fixture({ dirs, dirsEnabled })
    const rawDirs: DirsPart = { dirs: [
      { path: 'C:/Users/alice/.dsh/notes', files: [{ path: 'shared.md', data: base64('Alice') }] },
      { path: 'C:/Users/bob/.dsh/notes', files: [{ path: 'shared.md', data: base64('Bob') }] },
    ] }
    f.dav.seed(FILE_PATH, await seal(bundle(rawDirs), PASSPHRASE))
    const first = await sync(f.engine)
    expect(first.here).toContain('patch')
    expect(first.here).not.toContain('dirs')
    expect((await readRemote(f.dav)).dirs).toEqual(rawDirs)

    await writeFile(f.paths.patchFile, patchText('local-later'), 'utf8')
    const uploaded = await sync(f.engine)
    expect(uploaded.there).toContain('patch')
    expect(uploaded.pushed).toBe(true)
    const remote = await readRemote(f.dav)
    expect(remote.patch?.entries).toEqual(patchPart('local-later').entries)
    expect(remote.dirs).toEqual(rawDirs)
    await expect(readFile(join(f.home, 'notes', 'shared.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.io.differ).not.toHaveBeenCalled()
    expect(f.io.write).not.toHaveBeenCalled()
  })

  it('uses the raw cached baseline to recognize local path-only movement and fetch real remote B', async () => {
    const f = await legacyBaseline()
    await utimes(f.agents, LOCAL_NEWER, LOCAL_NEWER)
    f.dav.seed(FILE_PATH, await seal(changedFile(f.rawA, 'B', OLD_REMOTE_CREATED), PASSPHRASE))
    expect((await preview(f.engine)).changes).toContainEqual({ part: 'dirs', take: 'remote' })

    const received = await sync(f.engine)
    expect(received.here).toContain('dirs')
    expect(await readFile(f.agents, 'utf8')).toBe('B')
    expect((await readRemote(f.dav)).dirs?.dirs).toEqual([fileRow('~/AGENTS.md', 'B')])

    const putCount = f.dav.pathsFor('PUT').length
    const restarted = engineFor(f.paths, f.engine.config)
    expect((await sync(restarted)).pushed).toBe(false)
    expect(f.dav.pathsFor('PUT')).toHaveLength(putCount)
    expect(await readFile(f.agents, 'utf8')).toBe('B')
  })

  it('keeps real newer local C under the existing LWW rule rather than clearing its legacy baseline', async () => {
    const f = await legacyBaseline()
    await writeFile(f.agents, 'C', 'utf8')
    await utimes(f.agents, LOCAL_NEWER, LOCAL_NEWER)
    f.dav.seed(FILE_PATH, await seal(changedFile(f.rawA, 'B', OLD_REMOTE_CREATED), PASSPHRASE))
    expect((await preview(f.engine)).changes).toContainEqual({ part: 'dirs', take: 'newer-local' })

    const sent = await sync(f.engine)
    expect(sent.there).toContain('dirs')
    expect(sent.pushed).toBe(true)
    expect(await readFile(f.agents, 'utf8')).toBe('C')
    expect((await readRemote(f.dav)).dirs?.dirs).toEqual([fileRow('~/AGENTS.md', 'C')])
  })

  it('rejects an unverifiable stale cache without changing actual local D or current server B', async () => {
    const f = await legacyBaseline()
    const bytesC = await seal(changedFile(f.rawA, 'C', f.rawA.created), PASSPHRASE)
    await remember(f.paths, bytesC)
    const state = await loadState(f.paths)
    state.sum = sum(bytesC)
    delete (state.local as ScopedHashes).dirsHome
    delete (state.remote as ScopedHashes).dirsHome
    await saveState(f.paths, state)
    expect(hashesOf({ dirs: changedFile(f.rawA, 'C', f.rawA.created).dirs }).dirs).not.toBe(f.rawHash)
    await writeFile(f.agents, 'D', 'utf8')
    await utimes(f.agents, LOCAL_NEWER, LOCAL_NEWER)
    const bytesB = await seal(changedFile(f.rawA, 'B', OLD_REMOTE_CREATED), PASSPHRASE)
    const seededB = f.dav.seed(FILE_PATH, bytesB)
    const putCount = f.dav.pathsFor('PUT').length
    const writeCount = f.io.write.mock.calls.length

    const cannotVerify = /旧.*目录.*基线.*无法验证/
    await expect(preview(f.engine)).rejects.toThrow(cannotVerify)
    await expect(sync(f.engine)).rejects.toThrow(cannotVerify)
    expect(await readFile(f.agents, 'utf8')).toBe('D')
    expect(f.dav.files.get(FILE_PATH)?.data).toEqual(bytesB)
    expect(f.dav.files.get(FILE_PATH)?.etag).toBe(seededB.etag)
    expect(f.dav.pathsFor('PUT')).toHaveLength(putCount)
    expect(f.io.write.mock.calls).toHaveLength(writeCount)
    const after = await loadState(f.paths)
    expect(after.local?.dirs).toBe(f.rawHash)
    expect(after.remote?.dirs).toBe(f.rawHash)
  })

  it('does not treat a newer remote path-only rewrite of A as an edit that defeats real local C', async () => {
    const f = await legacyBaseline()
    await writeFile(f.agents, 'C', 'utf8')
    await utimes(f.agents, LOCAL_OLDER, LOCAL_OLDER)
    f.dav.seed(FILE_PATH, await seal(changedFile(f.rawA, 'A', NEW_REMOTE_CREATED, '~/AGENTS.md'), PASSPHRASE))
    expect((await preview(f.engine)).changes).toContainEqual({ part: 'dirs', take: 'local' })

    const sent = await sync(f.engine)
    expect(sent.there).toContain('dirs')
    expect(sent.pushed).toBe(true)
    expect(await readFile(f.agents, 'utf8')).toBe('C')
    expect((await readRemote(f.dav)).dirs?.dirs).toEqual([fileRow('~/AGENTS.md', 'C')])
  })
})
