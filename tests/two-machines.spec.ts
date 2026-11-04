/**
 * Two computers, one server: the whole point of the plugin, end to end.
 *
 * The engine tests below this one seed the server by hand, which pins one side
 * of the exchange but not the other. These tests run two real profiles — each
 * with its own DSH home, the way two machines really are — against one fake
 * WebDAV server, and ask the question the card promises to answer: after both
 * sides sync, is the second computer holding exactly what the first one changed?
 *
 * The scenarios are the ones a sync must never get wrong: an *existing* provider
 * whose address, models and place in the list were edited elsewhere; a file that
 * was rewritten underneath the sync with the very same bytes; and a plugin's own
 * data directory, named home-relatively because the two machines do not spell
 * their home directories the same way.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUNDLE_APP, BUNDLE_FORMAT, BUNDLE_VERSION, PARTS, type Bundle, type Part, type SyncConfig } from '../src/wire.ts'
import { open, seal } from '../src/crypto.ts'
import { configure } from '../src/index.ts'
import { engineFor, hashesOf, pathsOf, sync, take, type Engine } from '../src/engine.ts'
import { loadConfig } from '../src/state.ts'
import { readDirs } from '../src/dirs.ts'
import * as directoryFiles from '../src/dirs.ts'
import type { KeysPort } from '../src/keys.ts'
import type { ResolvedPaths } from '../src/paths.ts'
import { FakeDav } from './fake-dav.ts'
import { cleanUp, configFor, tempDir } from './harness.ts'

const PASSPHRASE = 'a passphrase'
const FILE_PATH = '/dav/dsh-webdav/dsh-profile.prop'

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

/** Inspect the decrypted server data, not merely the encrypted envelope. */
async function readRemote(dav: FakeDav): Promise<Bundle> {
  const bytes = dav.files.get(FILE_PATH)?.data
  expect(bytes).toBeDefined()
  return await open(bytes!, PASSPHRASE) as Bundle
}

/** A credential store held in memory, recording what was written to it. */
function keyStore(values: Record<string, string> = {}): KeysPort & { readonly written: { ref: string; value: string }[] } {
  const written: { ref: string; value: string }[] = []
  return {
    written,
    resolve: async (ref) => {
      const value = values[ref]
      return value === undefined ? undefined : { value, source: 'file' }
    },
    store: async (ref, value) => {
      written.push({ ref, value })
      values[ref] = value
    },
  }
}

/** One computer: a profile directory, its own DSH home, and the sync engine. */
interface Machine {
  paths: ResolvedPaths
  engine: Engine
  home: string
}

async function machine(
  name: string,
  dav: FakeDav,
  options: { home?: boolean; dirs?: string[]; keys?: KeysPort } = {},
): Promise<Machine> {
  const profile = await tempDir(`two-${name}-profile-`)
  const home = await tempDir(`two-${name}-home-`)
  const paths = options.home === false ? pathsOf(profile) : pathsOf(profile, home)
  const config: SyncConfig = configFor({
    passphrase: PASSPHRASE,
    ...(options.dirs === undefined ? {} : { dirs: options.dirs, dirsEnabled: options.dirs.length > 0 }),
  })
  return { paths, home, engine: engineFor(paths, config, options.keys) }
}

/** The patch of a profile with three providers, the way a live one is shaped. */
const RICH_PATCH_V1 = `# providers live here; the comments between the rows are the user's own

- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard

- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      alpha:
        displayName: 阿尔法
        api: openai-responses
        baseURL: https://alpha.example/v1
        apiKeyEnv: ALPHA_API_KEY
        models:
          # the workhorse
          - id: m1
            name: One
            contextWindow: 131072
            maxTokens: 8192
            input: [text, image]
          - id: m2
            name: Two
            contextWindow: 65536
            maxTokens: 4096
            input: [text]
      beta:
        displayName: 贝塔
        api: openai-completions
        baseURL: https://old.beta.example/v1
        apiKeyEnv: BETA_API_KEY
        models:
          - id: m1
            name: One
            contextWindow: 131072
            maxTokens: 8192
            input: [text]
      gamma:
        displayName: 伽马
        api: openai-responses
        baseURL: https://gamma.example/v1
        apiKeyEnv: GAMMA_API_KEY
        models:
          - id: m3
            name: Three
            contextWindow: 262144
            maxTokens: 16384
            input: [text, image]

- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    defaultPreset: danger-full-access
`

/** The same profile after the other computer edited its existing providers. */
const RICH_PATCH_V2 = `# providers live here; the comments between the rows are the user's own

- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard

- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      gamma:
        displayName: 伽马
        api: openai-responses
        baseURL: https://gamma.example/v1
        apiKeyEnv: GAMMA_API_KEY
        models:
          - id: m3
            name: Three
            contextWindow: 262144
            maxTokens: 16384
            input: [text, image]
      alpha:
        displayName: 阿尔法
        api: openai-responses
        baseURL: https://alpha.example/v1
        apiKeyEnv: ALPHA_API_KEY
        models:
          # the workhorse
          - id: m1
            name: One
            contextWindow: 200000
            maxTokens: 8192
            input: [text, image]
          - id: m2
            name: Two
            contextWindow: 65536
            maxTokens: 4096
            input: [text]
      beta:
        displayName: 贝塔
        api: openai-completions
        baseURL: https://new.beta.example/v1
        apiKeyEnv: BETA_API_KEY
        models:
          - id: m3
            name: Three Renamed
            contextWindow: 262144
            maxTokens: 16384
            input: [text, image]
          - id: m1
            name: One
            contextWindow: 131072
            maxTokens: 8192
            input: [text]
          - id: m4
            name: Four
            contextWindow: 32768
            maxTokens: 2048
            input: [text]

- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    defaultPreset: danger-full-access
`

/** The key-index a plugin keeps under its own folder in the DSH home. */
const KEY_INDEX_V1 = JSON.stringify({
  version: 1,
  providers: {
    wb: [{ ref: 'WB_API_KEY', alias: '主' }, { ref: 'WB_API_KEY_2', alias: '备用' }],
  },
  endpoints: {
    wb: { openai: 'https://old.wb.example/v1' },
  },
})

/** The same index after the plugin's UI changed a provider's address. */
const KEY_INDEX_V2 = JSON.stringify({
  version: 1,
  providers: {
    wb: [{ ref: 'WB_API_KEY', alias: '主' }, { ref: 'WB_API_KEY_2', alias: '备用' }],
  },
  endpoints: {
    wb: { openai: 'https://new.wb.example/v1', anthropic: 'https://new.wb.example/anthropic' },
  },
})

/** Write the patch text into a machine's profile. */
async function putPatch(machine: Machine, text: string): Promise<void> {
  await writeFile(machine.paths.patchFile, text, 'utf8')
}

/** Read a machine's patch text back. */
function patchOf(machine: Machine): Promise<string> {
  return readFile(machine.paths.patchFile, 'utf8')
}

/** The per-part hashes of what a machine holds now, in the wire's split view. */
async function partHashes(machine: Machine): Promise<Partial<Record<Part, string>>> {
  const snapshot = await take(machine.paths, machine.engine.config, machine.engine.credentials)
  return hashesOf({ ...snapshot.parts })
}

describe('an existing provider edited on the other computer', () => {
  it('brings the new address, the new model list and the new order into a profile that already had them', async () => {
    const dav = serve()
    const a = await machine('a', dav)
    const b = await machine('b', dav)
    await putPatch(a, RICH_PATCH_V1)
    await putPatch(b, RICH_PATCH_V1)

    // Both computers hold the same setup, and both have synced it.
    await sync(a.engine)
    await sync(b.engine)

    // Computer A edits providers it already had: a new address, a model added,
    // one removed, the list reordered, a field changed, and the provider list
    // itself put in another order. Then it pushes.
    await putPatch(a, RICH_PATCH_V2)
    const pushed = await sync(a.engine)
    expect(pushed.there).toContain('models')

    // Computer B syncs. Everything A changed has to be true of B's file too —
    // not just the new provider-shaped parts, and not just the ones B lacked.
    const result = await sync(b.engine)
    expect(result.here).toContain('models')
    expect(result.pushed).toBe(false)

    const text = await patchOf(b)
    // The address of a provider B already had.
    expect(text).toContain('https://new.beta.example/v1')
    expect(text).not.toContain('https://old.beta.example/v1')
    // The model list of that same provider: one removed, one added, reordered.
    // (alpha still carries its own m2; only beta's list dropped it.)
    const betaAt = text.indexOf('      beta:')
    const betaEnd = text.indexOf('\n- id: permission')
    const beta = text.slice(betaAt, betaEnd)
    expect(beta).toContain('id: m4')
    expect(beta).not.toContain('id: m2')
    const m3At = beta.indexOf('id: m3')
    const m1At = beta.indexOf('id: m1')
    const m4At = beta.indexOf('id: m4')
    expect(m3At).toBeGreaterThan(-1)
    expect(m3At).toBeLessThan(m1At)
    expect(m1At).toBeLessThan(m4At)
    // A field of a model B already had, changed on the other computer.
    expect(text).toContain('contextWindow: 200000')
    // The provider list order: gamma first, then alpha, then beta.
    const gammaAt = text.indexOf('      gamma:')
    const alphaAt = text.indexOf('      alpha:')
    expect(gammaAt).toBeGreaterThan(-1)
    expect(gammaAt).toBeLessThan(alphaAt)
    expect(alphaAt).toBeLessThan(betaAt)

    // And the strongest form of "consistent": the two machines' parts now hash
    // the same, models included, order and all.
    const hashesA = await partHashes(a)
    const hashesB = await partHashes(b)
    for (const part of PARTS) {
      if (hashesA[part] !== undefined) expect(hashesB[part], part).toBe(hashesA[part])
    }
    // The catalog itself, as plain data: same providers, same model order.
    const snapshotA = await take(a.paths, a.engine.config, a.engine.credentials)
    const snapshotB = await take(b.paths, b.engine.config, b.engine.credentials)
    expect(snapshotB.parts.models).toEqual(snapshotA.parts.models)
  })

  it('still brings the change in when this computer file was rewritten with the very same bytes', async () => {
    const dav = serve()
    const a = await machine('a', dav)
    const b = await machine('b', dav)
    await putPatch(a, RICH_PATCH_V1)
    await putPatch(b, RICH_PATCH_V1)
    await sync(a.engine)
    await sync(b.engine)

    // A host that normalises its files on boot touches them without changing
    // them: the bytes are the ones the last sync wrote, the stamp is not.
    await putPatch(b, await patchOf(b))
    await putPatch(a, RICH_PATCH_V2)
    await sync(a.engine)

    const result = await sync(b.engine)
    expect(result.here).toContain('models')
    const text = await patchOf(b)
    expect(text).toContain('https://new.beta.example/v1')
    expect(text).toContain('contextWindow: 200000')
  })

  it('carries a provider reordering made here up, and back down onto the other computer', async () => {
    // The mirror of the first test: B reorders its providers while A does
    // nothing, so B's copy is the answer and the next A sync takes it in.
    const dav = serve()
    const a = await machine('a', dav)
    const b = await machine('b', dav)
    await putPatch(a, RICH_PATCH_V1)
    await putPatch(b, RICH_PATCH_V1)
    await sync(a.engine)
    await sync(b.engine)

    const before = await patchOf(b)
    const alphaAt = before.indexOf('      alpha:')
    const betaAt = before.indexOf('      beta:')
    const endAt = before.indexOf('\n- id: permission')
    await putPatch(b, before.slice(0, alphaAt) + before.slice(betaAt, endAt) + before.slice(alphaAt, betaAt) + before.slice(endAt))
    const pushed = await sync(b.engine)
    expect(pushed.there).toContain('models')

    const result = await sync(a.engine)
    expect(result.here).toContain('models')
    const text = await patchOf(a)
    expect(text.indexOf('      beta:')).toBeLessThan(text.indexOf('      alpha:'))
  })
})

describe('extra directories and single files selected by their absolute local paths', () => {
  it('creates missing portable selections under the other DSH home and carries later edits back', async () => {
    const dav = serve()
    const portable = ['~/AGENTS.md', '~/notes']
    const a = await machine('a', dav)
    const b = await machine('b', dav)
    expect(a.home).not.toBe(b.home)
    await mkdir(join(a.home, 'notes', 'nested'), { recursive: true })
    await writeFile(join(a.home, 'AGENTS.md'), '# Instructions from A', 'utf8')
    await writeFile(join(a.home, 'notes', 'readme.md'), '# Notes from A', 'utf8')
    await writeFile(join(a.home, 'notes', 'nested', 'topic.md'), '# Nested note', 'utf8')

    // A uses the actual picker input, not a hand-written portable engine config.
    await configure(a.engine, {
      dirs: [join(a.home, 'AGENTS.md'), join(a.home, 'notes')],
      dirsEnabled: true,
    })
    await configure(b.engine, { dirs: portable, dirsEnabled: true })
    expect(a.engine.config.dirs).toEqual(portable)
    expect((await loadConfig(a.paths)).config.dirs).toEqual(portable)
    const missing = await readDirs(portable, b.home)
    expect(missing.entries).toEqual([])
    expect(missing.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '~/AGENTS.md', missing: true }),
      expect.objectContaining({ path: '~/notes', missing: true }),
    ]))

    expect((await sync(a.engine)).pushed).toBe(true)
    const firstRemote = await readRemote(dav)
    expect(firstRemote.dirs?.dirs.map(dir => dir.path)).toEqual(portable)
    expect(firstRemote.dirs?.dirs[0]).toMatchObject({ kind: 'file', files: [] })
    expect(Buffer.from(firstRemote.dirs?.dirs[0]?.data ?? '', 'base64').toString('utf8')).toBe('# Instructions from A')
    const received = await sync(b.engine)
    expect(received.here).toContain('dirs')
    expect(received.pushed).toBe(false)
    expect(await readFile(join(b.home, 'AGENTS.md'), 'utf8')).toBe('# Instructions from A')
    expect(await readFile(join(b.home, 'notes', 'readme.md'), 'utf8')).toBe('# Notes from A')
    expect(await readFile(join(b.home, 'notes', 'nested', 'topic.md'), 'utf8')).toBe('# Nested note')
    expect((await loadConfig(b.paths)).config.dirs).toEqual(portable)

    await writeFile(join(b.home, 'AGENTS.md'), '# Instructions from B', 'utf8')
    await writeFile(join(b.home, 'notes', 'readme.md'), '# Notes from B', 'utf8')
    expect((await sync(b.engine)).there).toContain('dirs')
    const returned = await sync(a.engine)
    expect(returned.here).toContain('dirs')
    expect(returned.pushed).toBe(false)
    expect(await readFile(join(a.home, 'AGENTS.md'), 'utf8')).toBe('# Instructions from B')
    expect(await readFile(join(a.home, 'notes', 'readme.md'), 'utf8')).toBe('# Notes from B')
    expect(await readFile(join(a.home, 'notes', 'nested', 'topic.md'), 'utf8')).toBe('# Nested note')
    expect((await partHashes(b)).dirs).toBe((await partHashes(a)).dirs)

    const finalRemote = await readRemote(dav)
    expect(finalRemote.dirs?.dirs.map(dir => dir.path)).toEqual(portable)
    for (const bundle of [firstRemote, finalRemote]) {
      const text = JSON.stringify(bundle)
      for (const home of [a.home, b.home]) {
        expect(text).not.toContain(JSON.stringify(home).slice(1, -1))
        expect(text).not.toContain(home.replace(/\\/g, '/'))
      }
    }
  })

  it('leaves missing and existing selections on B alone while dirs is off and preserves the remote bytes', async () => {
    const dav = serve()
    const portable = ['~/AGENTS.md', '~/notes']
    const a = await machine('a', dav)
    const b = await machine('b', dav)
    await mkdir(join(a.home, 'notes'), { recursive: true })
    await writeFile(join(a.home, 'AGENTS.md'), '# Instructions from A', 'utf8')
    await writeFile(join(a.home, 'notes', 'readme.md'), '# Notes from A', 'utf8')
    await configure(a.engine, { dirs: [join(a.home, 'AGENTS.md'), join(a.home, 'notes')], dirsEnabled: true })
    await configure(b.engine, { dirs: portable, dirsEnabled: false })
    await sync(a.engine)
    const before = dav.files.get(FILE_PATH)!
    const bytes = before.data.slice()
    const writes = dav.pathsFor('PUT').length

    const missing = await sync(b.engine)
    expect(missing.here).not.toContain('dirs')
    expect(missing.pushed).toBe(false)
    await expect(readFile(join(b.home, 'AGENTS.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(b.home, 'notes', 'readme.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    // Even readable, different local data is not an opinion while the switch is off.
    await mkdir(join(b.home, 'notes'), { recursive: true })
    await writeFile(join(b.home, 'AGENTS.md'), '# Local-only instructions', 'utf8')
    await writeFile(join(b.home, 'notes', 'readme.md'), '# Local-only notes', 'utf8')
    const existing = await sync(b.engine)
    expect(existing.here).not.toContain('dirs')
    expect(existing.pushed).toBe(false)
    expect(await readFile(join(b.home, 'AGENTS.md'), 'utf8')).toBe('# Local-only instructions')
    expect(await readFile(join(b.home, 'notes', 'readme.md'), 'utf8')).toBe('# Local-only notes')
    expect((await loadConfig(b.paths)).config).toMatchObject({ dirs: portable, dirsEnabled: false })
    expect(dav.pathsFor('PUT')).toHaveLength(writes)
    expect(dav.files.get(FILE_PATH)?.data).toEqual(bytes)
    expect(dav.files.get(FILE_PATH)?.etag).toBe(before.etag)
    expect((await readRemote(dav)).dirs?.dirs.map(dir => dir.path)).toEqual(portable)
  })

  it('migrates a legacy Windows default-home single file into B home and uploads later changes portably', async () => {
    const dav = serve()
    const b = await machine('b', dav, { dirs: ['~/AGENTS.md'] })
    const legacyPath = 'C:/Users/alice/.dsh/AGENTS.md'
    const bundle: Bundle = {
      format: BUNDLE_FORMAT,
      version: BUNDLE_VERSION,
      created: new Date().toISOString(),
      app: BUNDLE_APP,
      dirs: { dirs: [{ path: legacyPath, kind: 'file', data: Buffer.from('# Legacy instructions').toString('base64'), files: [] }] },
    }
    dav.seed(FILE_PATH, await seal(bundle, PASSPHRASE))

    // Fail safely on a regression before any I/O can reach a real Windows user home.
    // The service migrates the remote path before handing it to directory I/O.
    const guard = (paths: readonly string[]): void => {
      for (const path of paths) {
        if (/^c:\/users\/alice\/\.dsh(?:\/|$)/i.test(path.replace(/\\/g, '/'))) {
          throw new Error('The legacy remote home must be migrated before filesystem access')
        }
      }
    }
    const expand = directoryFiles.expandHome
    const read = directoryFiles.readDirs
    const differ = directoryFiles.dirsDiffer
    const write = directoryFiles.writeDirs
    vi.spyOn(directoryFiles, 'expandHome').mockImplementation((path, home) => {
      guard([path])
      return expand(path, home)
    })
    vi.spyOn(directoryFiles, 'readDirs').mockImplementation((paths, ...args) => {
      guard(paths)
      return read(paths, ...args)
    })
    vi.spyOn(directoryFiles, 'dirsDiffer').mockImplementation((part, ...args) => {
      guard(part.dirs.map(dir => dir.path))
      return differ(part, ...args)
    })
    vi.spyOn(directoryFiles, 'writeDirs').mockImplementation((part, ...args) => {
      guard(part.dirs.map(dir => dir.path))
      return write(part, ...args)
    })

    const received = await sync(b.engine)
    expect(received.here).toContain('dirs')
    expect(await readFile(join(b.home, 'AGENTS.md'), 'utf8')).toBe('# Legacy instructions')
    expect(b.engine.config.dirs).toEqual(['~/AGENTS.md'])

    await writeFile(join(b.home, 'AGENTS.md'), '# Updated on B', 'utf8')
    expect((await sync(b.engine)).there).toContain('dirs')
    const remote = await readRemote(dav)
    expect(remote.dirs?.dirs).toEqual([
      { path: '~/AGENTS.md', kind: 'file', data: Buffer.from('# Updated on B').toString('base64'), files: [] },
    ])
    expect(JSON.stringify(remote)).not.toContain(legacyPath)
    expect(JSON.stringify(remote)).not.toContain(JSON.stringify(b.home).slice(1, -1))
  })
})

describe('a plugin data directory named home-relatively', () => {
  it('syncs the same folder of two differently-homed machines, keys and all', async () => {
    const dav = serve()
    const storeA = keyStore({ WB_API_KEY: 'wb-one', WB_API_KEY_2: 'wb-two' })
    const storeB = keyStore({})
    // The two machines name their DSH homes differently, as two real computers
    // do; the path in the configuration is the same `~/…` name on both.
    const a = await machine('a', dav, { dirs: ['~/dsh-model-think-level'], keys: storeA })
    const b = await machine('b', dav, { dirs: ['~/dsh-model-think-level'], keys: storeB })
    await putPatch(a, RICH_PATCH_V1)
    await putPatch(b, RICH_PATCH_V1)
    await mkdir(join(a.home, 'dsh-model-think-level'), { recursive: true })
    await writeFile(join(a.home, 'dsh-model-think-level', 'key-index.json'), KEY_INDEX_V1, 'utf8')

    await sync(a.engine)
    const bFirst = await sync(b.engine)

    // The directory arrived on B, under B's own home.
    const arrived = await readFile(join(b.home, 'dsh-model-think-level', 'key-index.json'), 'utf8')
    expect(arrived).toBe(KEY_INDEX_V1)
    // The key the index names but the profile does not travelled too: B's store
    // now holds the value, so the route authenticates there as well.
    expect(storeB.written.map((entry) => entry.ref)).toContain('WB_API_KEY_2')

    // The plugin's own data changes on A — a new endpoint, the very edit the
    // user makes in that plugin's UI — and B has to follow.
    await writeFile(join(a.home, 'dsh-model-think-level', 'key-index.json'), KEY_INDEX_V2, 'utf8')
    const pushed = await sync(a.engine)
    expect(pushed.there).toContain('dirs')
    const result = await sync(b.engine)
    expect(result.here).toContain('dirs')

    const updated = await readFile(join(b.home, 'dsh-model-think-level', 'key-index.json'), 'utf8')
    expect(updated).toBe(KEY_INDEX_V2)
    expect(bFirst.pushed).toBe(false)
  })

  it('reports a home-relative directory on a machine that cannot resolve one, and carries the server copy', async () => {
    const dav = serve()
    const a = await machine('a', dav, { dirs: ['~/dsh-model-think-level'] })
    const b = await machine('b', dav, { home: false, dirs: ['~/dsh-model-think-level'] })
    await putPatch(a, RICH_PATCH_V1)
    await mkdir(join(a.home, 'dsh-model-think-level'), { recursive: true })
    await writeFile(join(a.home, 'dsh-model-think-level', 'key-index.json'), KEY_INDEX_V1, 'utf8')

    await sync(a.engine)
    const remoteBefore = dav.files.get(FILE_PATH)!
    const remoteBytes = remoteBefore.data.slice()
    // Machine B knows no DSH home at all: the directory is a problem to report,
    // the server's copy rides through, and nothing is written anywhere.
    const read = await readDirs(['~/dsh-model-think-level'], undefined)
    expect(read.problems).toHaveLength(1)
    expect(read.problems[0].path).toBe('~/dsh-model-think-level')

    const result = await sync(b.engine)
    expect(result.pushed).toBe(false)
    expect(result.here).not.toContain('dirs')
    expect(b.paths.homeDir).toBeUndefined()
    await expect(readFile(join(b.home, 'dsh-model-think-level', 'key-index.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(dav.files.get(FILE_PATH)?.data).toEqual(remoteBytes)
    expect(dav.files.get(FILE_PATH)?.etag).toBe(remoteBefore.etag)
    expect((await readRemote(dav)).dirs?.dirs[0]?.path).toBe('~/dsh-model-think-level')
    // The part is still named on this machine — dropping it would delete it for
    // the computers that can use it.
    const snapshot = await take(b.paths, b.engine.config, b.engine.credentials)
    expect(snapshot.dirs.problems.map((problem) => problem.path)).toContain('~/dsh-model-think-level')
  })
})

describe('consistency, measured as the card promises it', () => {
  it('ends with both machines hashing the same on every part they carry', async () => {
    const dav = serve()
    const a = await machine('a', dav, { dirs: ['~/dsh-model-think-level'], keys: keyStore({ WB_API_KEY: 'one' }) })
    const b = await machine('b', dav, { dirs: ['~/dsh-model-think-level'], keys: keyStore({}) })
    await putPatch(a, RICH_PATCH_V1)
    await putPatch(b, RICH_PATCH_V1)
    await mkdir(join(a.home, 'dsh-model-think-level'), { recursive: true })
    await writeFile(join(a.home, 'dsh-model-think-level', 'key-index.json'), KEY_INDEX_V1, 'utf8')

    await sync(a.engine)
    await sync(b.engine)

    await putPatch(a, RICH_PATCH_V2)
    await writeFile(join(a.home, 'dsh-model-think-level', 'key-index.json'), KEY_INDEX_V2, 'utf8')
    await sync(a.engine)
    await sync(b.engine)

    const hashesA = await partHashes(a)
    const hashesB = await partHashes(b)
    for (const part of PARTS) {
      if (hashesA[part] === undefined) continue
      expect(hashesB[part], `part ${part}`).toBe(hashesA[part])
    }
    // The catalog itself: same providers, same models, same order on both.
    const snapshotA = await take(a.paths, a.engine.config, a.engine.credentials)
    const snapshotB = await take(b.paths, b.engine.config, b.engine.credentials)
    expect(snapshotB.parts.models).toEqual(snapshotA.parts.models)
    expect(snapshotB.parts.dirs).toEqual(snapshotA.parts.dirs)
  })
})
