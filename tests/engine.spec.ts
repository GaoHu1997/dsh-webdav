/**
 * The sync itself: the three-way merge, and the three actions around it.
 *
 * These are the tests that matter most. The per-part merge is the one piece of
 * this plugin that can destroy somebody's setup if it decides wrongly, so every
 * branch of it is exercised against a real profile on disk and a real WebDAV
 * server that misbehaves on request.
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUNDLE_APP,
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  PARTS,
  type Bundle,
  type Part,
  type SyncConfig,
} from '../src/wire.ts'
import { PassphraseError, open, seal, sum } from '../src/crypto.ts'
import {
  check,
  engineFor,
  preview,
  restore,
  status,
  sync,
  take,
  turnOff,
  undo,
  upload,
} from '../src/engine.ts'
import { loadConfig, loadState, cacheFile, keptDir } from '../src/state.ts'
import { collect as collectParts, readManifest, readPatch } from '../src/store.ts'
import { FakeDav } from './fake-dav.ts'
import { cleanUp, configFor, fakeNodeModules, tempDir, writeProfile, SAMPLE_MANIFEST, SAMPLE_PATCH } from './harness.ts'
import type { ResolvedPaths } from '../src/paths.ts'

const FILE_PATH = '/dav/dsh-webdav/dsh-profile.prop'
const PASSPHRASE = 'a passphrase'

let stop: (() => void) | undefined

afterEach(async () => {
  stop?.()
  stop = undefined
  await cleanUp()
})

/** A fake server standing in for the remote, with the plugin's folder made. */
function serve(options = {}): FakeDav {
  const dav = new FakeDav(options)
  dav.seedCollection('/dav/dsh-webdav')
  stop = dav.use()
  return dav
}

function config(over: Partial<SyncConfig> = {}): SyncConfig {
  return configFor({ passphrase: PASSPHRASE, ...over })
}

/** Seal a bundle and put it on the server, as another computer would have. */
async function seedRemote(dav: FakeDav, parts: Partial<Record<Part, unknown>>, created?: string): Promise<Bundle> {
  const bundle: Bundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    created: created ?? new Date().toISOString(),
    app: BUNDLE_APP,
    ...(parts as Partial<Bundle>),
  }
  dav.seed(FILE_PATH, await seal(bundle, PASSPHRASE))
  return bundle
}

/** The bundle the server holds now, opened. */
async function readRemote(dav: FakeDav, passphrase = PASSPHRASE): Promise<Bundle> {
  const bytes = dav.files.get(FILE_PATH)?.data
  expect(bytes).toBeDefined()
  return (await open(bytes as Uint8Array, passphrase)) as Bundle
}

/** A profile whose model catalog names one provider, with a marker in it. */
const ONE_PROVIDER = `# a comment a sync must not eat

- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      free: # the local gateway
        displayName: 免费
        apiKeyEnv: FREE_API_KEY

- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    defaultPreset: danger-full-access
`

/** The same patch with the provider's name changed. */
const ONE_PROVIDER_EDITED = ONE_PROVIDER.replace('displayName: 免费', 'displayName: 免费网关')

/** Read a profile's patch text back. */
async function patchText(paths: ResolvedPaths): Promise<string> {
  return readFile(paths.patchFile, 'utf8')
}

/**
 * What the four parts of a profile say, rather than how its file is written.
 *
 * Restoring and undoing round the patch through YAML, which leaves a comment
 * off a row it replaced behind — the file's own wording is not preserved across
 * a write. Comparing the parts says whether the setup came back without
 * pretending the bytes did.
 */
async function collect(paths: ResolvedPaths): Promise<Record<string, unknown>> {
  const parts = collectParts(await readPatch(paths), await readManifest(paths))
  return JSON.parse(JSON.stringify(parts)) as Record<string, unknown>
}
describe('a first sync', () => {
  it('writes this computer setup to an empty folder, and says it pushed', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    const result = await sync(engineFor(paths, config()))

    expect(result.pushed).toBe(true)
    expect(result.here).toEqual([])
    expect(dav.files.has(FILE_PATH)).toBe(true)

    const remote = await readRemote(dav)
    expect(remote.models).toEqual({ config: { providers: { free: expect.objectContaining({ displayName: '免费' }) } } })
    expect(remote.plugins).toBeDefined()
    expect(remote.patch).toBeDefined()
  })

  it('leaves the profile untouched, comments and all', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    serve()
    await sync(engineFor(paths, config()))
    // Nothing came in, so the person's file must be exactly as they left it.
    expect(await patchText(paths)).toBe(ONE_PROVIDER)
  })

  it('does nothing at all when neither side moved', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    const engine = engineFor(paths, config())
    await sync(engine)
    const writes = dav.pathsFor('PUT').length
    const again = await sync(engine)
    expect(again.pushed).toBe(false)
    expect(again.here).toEqual([])
    expect(again.there).toEqual([])
    expect(dav.pathsFor('PUT').length).toBe(writes)
  })

  it('pushes again when asked to, even with nothing to say', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    const engine = engineFor(paths, config())
    await sync(engine)
    const writes = dav.pathsFor('PUT').length
    await sync(engine, { force: true })
    expect(dav.pathsFor('PUT').length).toBeGreaterThan(writes)
  })

  it('sends the configured request headers with the requests a sync makes', async () => {
    // The headers are how this computer gets through whatever stands in front of
    // the server, so they have to reach every request the sync makes, not only
    // the handshake a connection test would do.
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    await sync(engineFor(paths, config({ headers: 'X-Proxy-Key: sekret' })))
    expect(dav.calls.length).toBeGreaterThan(0)
    expect(dav.calls.every((entry) => entry.headers['x-proxy-key'] === 'sekret')).toBe(true)
  })
})

describe('one side changed', () => {
  it('pushes a part only this computer changed, leaving the rest alone', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    const engine = engineFor(paths, config())
    await sync(engine)

    await writeFile(paths.patchFile, ONE_PROVIDER_EDITED, 'utf8')
    const result = await sync(engine)

    expect(result.there).toContain('models')
    expect(result.here).toEqual([])
    const remote = await readRemote(dav)
    expect(JSON.stringify(remote.models)).toContain('免费网关')
  })

  it('brings in a part only the server changed, and rewrites the file', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    const engine = engineFor(paths, config())
    await sync(engine)

    // Another computer edits the catalog: one part, and only it.
    const mine = await readRemote(dav)
    await seedRemote(dav, {
      ...mine,
      models: { config: { providers: { other: { displayName: '另一台' } } } },
    }, new Date(Date.now() + 60_000).toISOString())

    const result = await sync(engine)
    expect(result.here).toContain('models')
    expect(result.pushed).toBe(false)
    expect(await patchText(paths)).toContain('另一台')
  })

  it('takes a part away when the other computer removed it', async () => {
    // The server holds no models at all, which is a removal, not "unchanged".
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    const engine = engineFor(paths, config())
    await sync(engine)
    await seedRemote(dav, { plugins: (await readRemote(dav)).plugins }, new Date(Date.now() + 60_000).toISOString())

    const result = await sync(engine)
    expect(result.here).toContain('models')
    expect(await patchText(paths)).not.toContain('FREE_API_KEY')
  })

  it('notes what came in, and the notice can be dismissed', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    const engine = engineFor(paths, config())
    await sync(engine)
    const mine = await readRemote(dav)
    await seedRemote(dav, { ...mine, models: { config: { providers: { other: { id: 1 } } } } }, new Date(Date.now() + 60_000).toISOString())
    await sync(engine)

    const shown = await status(engine)
    expect(shown.notice?.here).toContain('models')
  })
})

describe('both sides changed one part', () => {
  it('keeps the newer one, and puts the other in the sync folder', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    const engine = engineFor(paths, config())
    await sync(engine)

    // The other computer's copy is stamped in the past, so this computer wins.
    const theirs = new Date(Date.now() - 600_000).toISOString()
    await seedRemote(dav, { models: { config: { providers: { theirs: { id: 'theirs' } } } } }, theirs)
    await writeFile(paths.patchFile, ONE_PROVIDER_EDITED, 'utf8')

    const result = await sync(engine)
    expect(result.saved).toBeDefined()
    expect(result.there).toContain('models')
    expect(await patchText(paths)).toContain('免费网关')

    // Both sides of the conflict are kept, so the copy that lost is still
    // readable: the one from here, and the one the server held.
    const { readdir } = await import('node:fs/promises')
    const keptNames = await readdir(result.saved as string)
    expect(keptNames.some(name => name.includes('this-computer'))).toBe(true)
    expect(keptNames.some(name => name.includes('server'))).toBe(true)
  })

  it('yields to the server when its copy is the newer one', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    const engine = engineFor(paths, config())
    await sync(engine)

    await seedRemote(
      dav,
      { models: { config: { providers: { theirs: { id: 'theirs' } } } } },
      new Date(Date.now() + 600_000).toISOString(),
    )
    await writeFile(paths.patchFile, ONE_PROVIDER_EDITED, 'utf8')

    const result = await sync(engine)
    expect(result.here).toContain('models')
    expect(await patchText(paths)).toContain('theirs')
  })
})

describe('a server that answers without ETags', () => {
  it('keeps this computer first edit, and never takes it back on the next sync', async () => {
    // A blind write cannot be made conditional, so the plugin re-reads the file
    // afterwards. That read must not be mistaken for somebody else having
    // changed it: the baseline it just wrote is the baseline it has to keep.
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve({ noEtag: true })
    const engine = engineFor(paths, config())
    await sync(engine)

    await writeFile(paths.patchFile, ONE_PROVIDER_EDITED, 'utf8')
    const pushed = await sync(engine)
    expect(pushed.there).toContain('models')
    expect(pushed.pushed).toBe(true)

    // The next sync has to read the whole file back, because the blind write
    // gave no ETag to compare against. That read is not somebody else's edit:
    // the baseline just written stands, the edit is untouched and stays here.
    const again = await sync(engine)
    expect(again.pushed).toBe(false)
    expect(again.here).toEqual([])
    expect(again.there).toEqual([])
    expect(await patchText(paths)).toContain('免费网关')
    expect(JSON.stringify(await readRemote(dav))).toContain('免费网关')
  })

  it('settles: a third sync has nothing to say', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve({ noEtag: true })
    const engine = engineFor(paths, config())
    await sync(engine)
    await writeFile(paths.patchFile, ONE_PROVIDER_EDITED, 'utf8')
    await sync(engine)
    await sync(engine)
    const third = await sync(engine)
    expect(third.pushed).toBe(false)
    expect(third.here).toEqual([])
    expect(third.there).toEqual([])
    expect(JSON.stringify(await readRemote(dav))).toContain('免费网关')
  })
})

describe('the file on the server is not readable as ours', () => {
  it('refuses a file sealed with another passphrase, and says so', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    const other = await seal({ format: BUNDLE_FORMAT, version: BUNDLE_VERSION, created: new Date().toISOString(), app: BUNDLE_APP }, 'another passphrase')
    dav.seed(FILE_PATH, other)

    await expect(sync(engineFor(paths, config()))).rejects.toThrow(/口令打不开服务器上的文件/)
  })

  it('refuses a file that is not a backup at all, and never writes over it', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    dav.seed(FILE_PATH, '<html><body>the sign-in page</body></html>')

    await expect(sync(engineFor(paths, config()))).rejects.toThrow(/不是 dsh 同步备份/)
    expect(dav.text(FILE_PATH)).toBe('<html><body>the sign-in page</body></html>')
  })

  it('rebuilds over a file that was cut short, when this computer has synced before', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    const engine = engineFor(paths, config())
    await sync(engine)

    // A relay cut the write, so the server now holds a fragment of a real
    // backup: it begins like one and stops in the middle.
    const full = await seal(
      { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, created: new Date().toISOString(), app: BUNDLE_APP, models: { config: { a: 1 } } },
      PASSPHRASE,
    )
    dav.files.set(FILE_PATH, { data: full.slice(0, Math.floor(full.byteLength / 2)), etag: '"cut"' })

    const result = await sync(engine)
    expect(result.pushed).toBe(true)
    const remote = await readRemote(dav)
    expect(remote.models).toBeDefined()
  })

  it('keeps the damaged bytes aside before rebuilding over them', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    const engine = engineFor(paths, config())
    await sync(engine)
    const full = await seal({ format: BUNDLE_FORMAT, version: BUNDLE_VERSION, created: new Date().toISOString(), app: BUNDLE_APP }, PASSPHRASE)
    dav.files.set(FILE_PATH, { data: full.slice(0, 120), etag: '"cut"' })
    await sync(engine)

    const { readdir } = await import('node:fs/promises')
    const kept = await readdir(`${paths.stateDir}/sync`)
    expect(kept.some(name => name.includes('server-damaged'))).toBe(true)
  })

  it('treats a well-sealed file whose parts make no sense as damaged, not as an instruction', async () => {
    // A bundle that opens is not enough: `patch: { entries: 5 }` is not a patch,
    // and passing it on would turn into `wanted.map is not a function` deep in
    // the merge, or write nonsense into the profile.
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    const engine = engineFor(paths, config())
    await sync(engine)

    await seedRemote(dav, { patch: { entries: 5 } })
    const result = await sync(engine)
    expect(result.pushed).toBe(true)
    expect((await readRemote(dav)).patch?.entries).toEqual(expect.any(Array))
    // This computer's own setup came through the rebuild untouched.
    expect(await patchText(paths)).toContain('免费')
  })

  it('names the part it could not read', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    await seedRemote(dav, { plugins: { dependencies: 'not-an-object', bundles: [] } })
    await expect(sync(engineFor(paths, config()))).rejects.toThrow(/「plugins」/)
  })
})

describe('restore, upload and undo', () => {
  it('restore makes the server copy this computer setup, keeping what was here', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    const engine = engineFor(paths, config())
    await sync(engine)
    await seedRemote(dav, { models: { config: { providers: { theirs: { id: 'theirs' } } } } }, new Date(Date.now() + 600_000).toISOString())

    const result = await restore(engine)
    expect(result.here).toContain('models')
    expect(await patchText(paths)).toContain('theirs')
    expect((await loadState(paths)).undo).toBeTruthy()
  })

  it('restore says there is nothing to restore when the server holds no file', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    serve()
    await expect(restore(engineFor(paths, config()))).rejects.toThrow(/没有可恢复的内容/)
  })

  it('undo puts back what the restore replaced', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    const engine = engineFor(paths, config())
    await sync(engine)
    await seedRemote(dav, { models: { config: { providers: { theirs: { id: 'theirs' } } } } }, new Date(Date.now() + 600_000).toISOString())
    await restore(engine)
    expect(await patchText(paths)).toContain('theirs')

    const result = await undo(engine)
    expect(result.here).toContain('models')
    expect(await patchText(paths)).toContain('FREE_API_KEY')
  })

  it('undo refuses when there is nothing to undo', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    serve()
    await expect(undo(engineFor(paths, config()))).rejects.toThrow(/没有可撤销的恢复/)
  })

  it('upload replaces a file on the server that is not ours', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    dav.seed(FILE_PATH, 'some other application file')

    const result = await upload(engineFor(paths, config()))
    expect(result.pushed).toBe(true)
    expect((await readRemote(dav)).models).toBeDefined()
  })

  it('upload refuses to replace a backup this computer can open', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    await seedRemote(dav, { models: { config: { providers: {} } } })
    await expect(upload(engineFor(paths, config()))).rejects.toThrow(/改用「立即同步」/)
  })

  it('upload refuses to replace a backup sealed with another passphrase', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    dav.seed(FILE_PATH, await seal({ format: BUNDLE_FORMAT, version: BUNDLE_VERSION, created: new Date().toISOString(), app: BUNDLE_APP }, 'somebody else'))
    await expect(upload(engineFor(paths, config()))).rejects.toThrow(/另一个口令加密的/)
  })
})

describe('the parts a configuration leaves out', () => {
  it('carries an unsynced part through the upload untouched', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    const engine = engineFor(paths, config())
    await sync(engine)

    // Turning a part off must never delete it for the computers that still
    // sync it, so a later edit elsewhere still travels through this one.
    const off = engineFor(paths, config({ models: false }))
    const mine = await readRemote(dav)
    await seedRemote(dav, { ...mine, models: { config: { providers: { theirs: { id: 'theirs' } } } } }, new Date(Date.now() + 600_000).toISOString())
    await writeFile(paths.patchFile, ONE_PROVIDER_EDITED, 'utf8')

    await sync(off)
    const remote = await readRemote(dav)
    expect(JSON.stringify(remote.models)).toContain('theirs')
    expect(await patchText(paths)).not.toContain('theirs')
  })

  it('a part turned off stays off through restore and undo', async () => {
    // Restore and undo write to this computer's files like any other action, so
    // they are bound by the same switch. A restore is not a way round it.
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    await sync(engineFor(paths, config()))
    await seedRemote(
      dav,
      {
        models: { config: { providers: { theirs: { displayName: '他们的', apiKeyEnv: 'THEIRS' } } } },
        patch: { entries: [{ id: 'permission', name: '@deepseek-ai/dsh-permission-presets', config: { defaultPreset: 'ask' } }] },
      },
      new Date(Date.now() + 600_000).toISOString(),
    )
    const before = await collect(paths)

    const off = engineFor(paths, config({ patch: false }))
    await restore(off)
    const afterRestore = await patchText(paths)
    expect(afterRestore).toContain('THEIRS')
    expect(afterRestore).not.toContain('defaultPreset: ask')

    await undo(off)
    expect(await collect(paths)).toEqual(before)
  })
})

describe('status, check and preview', () => {
  it('status reports every part, the paths, and that it is configured', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    serve()
    const shown = await status(engineFor(paths, config()))
    expect(shown.configured).toBe(true)
    expect(shown.parts.map(entry => entry.part)).toEqual([...PARTS])
    expect(shown.paths.profileDir).toBe(paths.profileDir)
    expect(JSON.stringify(shown.config)).not.toContain(PASSPHRASE)
    expect(shown.config.passphraseSet).toBe(true)
  })

  it('status reports a part this computer changed', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    serve()
    const engine = engineFor(paths, config())
    await sync(engine)
    await writeFile(paths.patchFile, ONE_PROVIDER_EDITED, 'utf8')
    const shown = await status(engine)
    expect(shown.parts.find(entry => entry.part === 'models')?.localChanged).toBe(true)
  })

  it('status does not also claim the server changed when only this side did', async () => {
    // After a good sync the two baselines are the same, so "does here differ
    // from what we last knew the server held" is the same question as "did this
    // computer change". Answering both would tell the card both sides moved.
    const paths = await writeProfile(ONE_PROVIDER)
    serve()
    const engine = engineFor(paths, config())
    await sync(engine)
    await writeFile(paths.patchFile, ONE_PROVIDER_EDITED, 'utf8')

    const models = (await status(engine)).parts.find(entry => entry.part === 'models')
    expect(models?.localChanged).toBe(true)
    expect(models?.remoteChanged).toBe(false)
  })

  it('status does not claim the server changed before the first sync', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    serve()
    for (const entry of (await status(engineFor(paths, config()))).parts) {
      expect(entry.remoteChanged).toBe(false)
    }
  })

  it('status does not call a part changed before the first sync', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    serve()
    const shown = await status(engineFor(paths, config()))
    for (const part of shown.parts) expect(part.localChanged).toBe(false)
  })

  it('check passes and reports a file that is already there', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    await seedRemote(dav, { models: { config: {} } })
    const outcome = await check(engineFor(paths, config()))
    expect(outcome.ok).toBe(true)
    expect(outcome.hasBackup).toBe(true)
    expect(outcome.size).toBeGreaterThan(0)
    expect(outcome.created).toBeDefined()
  })

  it('check passes and says there is no backup yet on an empty folder', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    serve()
    const outcome = await check(engineFor(paths, config()))
    expect(outcome.ok).toBe(true)
    expect(outcome.hasBackup).toBe(false)
  })

  it('check reports a passphrase that does not open the file on the server', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    dav.seed(FILE_PATH, await seal({ format: BUNDLE_FORMAT, version: BUNDLE_VERSION, created: new Date().toISOString(), app: BUNDLE_APP }, 'another passphrase'))
    const outcome = await check(engineFor(paths, config()))
    expect(outcome.ok).toBe(false)
    expect(outcome.hasBackup).toBe(true)
    expect(outcome.message).toMatch(/口令打不开它/)
  })

  it('check refuses an address it was never given', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    serve()
    await expect(check(engineFor(paths, config({ url: '' })))).rejects.toThrow(/请先填写同步地址/)
  })

  it('preview says what a sync would do and writes nothing', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    const engine = engineFor(paths, config())
    await sync(engine)
    const before = await patchText(paths)

    const mine = await readRemote(dav)
    await seedRemote(dav, { ...mine, models: { config: { providers: { theirs: { id: 'theirs' } } } } }, new Date(Date.now() + 600_000).toISOString())
    const shown = await preview(engine)
    expect(shown.changes).toContainEqual({ part: 'models', take: 'remote' })
    expect(await patchText(paths)).toBe(before)
  })

  it('preview says nothing would happen when nothing changed', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    serve()
    const engine = engineFor(paths, config())
    await sync(engine)
    expect((await preview(engine)).changes).toEqual([])
  })
})

describe('the state that survives a restart', () => {
  it('does not re-read the server when it said the file is unchanged', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    const engine = engineFor(paths, config())
    await sync(engine)
    const reads = dav.pathsFor('GET').length
    await sync(engine)
    // One conditional read that came back 304, and no full read of the body.
    expect(dav.pathsFor('GET').length).toBe(reads + 1)
  })

  it('merges against the cached copy when the server said unchanged and this computer moved', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    const engine = engineFor(paths, config())
    await sync(engine)
    await writeFile(paths.patchFile, ONE_PROVIDER_EDITED, 'utf8')

    const result = await sync(engine)
    expect(result.there).toContain('models')
    expect(await readRemote(dav)).toBeDefined()
    expect(JSON.stringify(await readRemote(dav))).toContain('免费网关')
  })

  it('starts afresh when the configuration names a different account', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    await sync(engineFor(paths, config()))
    const before = await loadState(paths)
    expect(before.local).toBeDefined()

    // A different address is a different file: the old hashes are no baseline,
    // so the next sync must treat it as the first one again and push everything.
    await sync(engineFor(paths, config({ url: 'https://other.test/dav' })))
    const after = await loadState(paths)
    expect(after.key).not.toBe(before.key)
    expect(after.local).toBeDefined()
    expect(Object.keys(after.local ?? {}).sort()).toEqual(Object.keys(before.local ?? {}).sort())
  })

  it('records why a sync failed, so the card can say it', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    const engine = engineFor(paths, config())
    await sync(engine)

    // A passphrase that does not open what is on the server: the failure is
    // kept against this configuration, and reading the card must not need the
    // server at all.
    const wrong = engineFor(paths, config({ passphrase: 'a different passphrase' }))
    await expect(sync(wrong)).rejects.toThrow(/口令打不开服务器上的文件/)
    await expect(status(wrong)).resolves.toMatchObject({ error: expect.stringMatching(/口令/) })
  })

  it('keeps the state when sync is turned off, so turning it on is not a rejoin', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    serve()
    const engine = engineFor(paths, config())
    await sync(engine)
    await turnOff(engine)

    const { config: stored } = await loadConfig(paths)
    expect(stored.url).toBe('')
    expect(stored.passphrase).toBe(PASSPHRASE)
    expect((await loadState(paths)).local).toBeDefined()
  })
})

describe('a profile that has never been used', () => {
  it('a sync from a machine with nothing still writes what it has', async () => {
    const paths = await writeProfile('', SAMPLE_MANIFEST)
    const dav = serve()
    const result = await sync(engineFor(paths, config()))
    expect(result.pushed).toBe(true)
    const remote = await readRemote(dav)
    expect(remote.models).toBeUndefined()
    expect(remote.plugins).toBeDefined()
  })

  it('brings in a whole setup from the server when there is nothing here', async () => {
    const paths = await writeProfile('')
    const dav = serve()
    await seedRemote(dav, {
      models: { config: { providers: { theirs: { id: 'theirs' } } } },
      defaults: { config: { provider: 'theirs' } },
      patch: { entries: [{ id: 'permission', name: '@deepseek-ai/dsh-permission-presets', config: {} }] },
      plugins: { dependencies: { 'dsh-git-branch-manage': '^1.0.2' }, bundles: ['@deepseek-ai/dsh-base', 'dsh-git-branch-manage'] },
    })

    const result = await sync(engineFor(paths, config()))
    expect(result.here).toEqual(expect.arrayContaining(['models', 'defaults', 'patch']))
    const text = await patchText(paths)
    expect(text).toContain('theirs')
    expect(text).toContain('permission')
    // The manifest is mirrored from the server's, not merged with the empty one.
    const manifest = JSON.parse(await readFile(paths.packageFile, 'utf8')) as { dependencies: Record<string, string> }
    expect(manifest.dependencies['dsh-git-branch-manage']).toBe('^1.0.2')
  })

  it('still keeps the comments the file already had when it merges into it', async () => {
    const paths = await writeProfile()
    const dav = serve()
    await seedRemote(dav, { models: { config: { providers: { theirs: { id: 'theirs' } } } } }, new Date(Date.now() + 600_000).toISOString())
    await sync(engineFor(paths, config()))
    const text = await patchText(paths)
    expect(text).toContain('# Your patch layer for this dsh profile')
    expect(text).toContain('transcriptView: standard')
    expect(text).toContain('theirs')
  })

  it('never carries this plugin own row, so it cannot sync itself away', async () => {
    const withSelf = `${SAMPLE_PATCH}
- id: dsh-webdav-sync
  name: 'dsh-webdav-sync'
`
    const paths = await writeProfile(withSelf)
    const dav = serve()
    await sync(engineFor(paths, config()))
    const remote = await readRemote(dav)
    const entries = (remote.patch?.entries ?? []) as Array<{ id?: string }>
    expect(entries.some(entry => entry.id === 'dsh-webdav-sync')).toBe(false)
    // And it is still in the file here, exactly where the user put it.
    expect(await patchText(paths)).toBe(withSelf)
  })
})

describe('plugins that are declared but not installed', () => {
  it('reports a pending install and does not install it', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    await fakeNodeModules(paths, [])
    const dav = serve()
    await seedRemote(dav, {
      plugins: { dependencies: { 'dsh-git-branch-manage': '^1.0.2' }, bundles: ['@deepseek-ai/dsh-base', 'dsh-git-branch-manage'] },
    })
    const result = await sync(engineFor(paths, config()))
    expect(result.pendingInstall).toBe(true)
    // The card names them, so the names have to travel with the flag.
    expect(result.pendingNames).toEqual(['dsh-git-branch-manage'])
    const shown = await status(engineFor(paths, config()))
    expect(shown.pendingInstall).toBe(true)
    expect(shown.pendingNames).toEqual(['dsh-git-branch-manage'])
  })

  it('does not report a pending install when the package is there', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    await fakeNodeModules(paths, ['dsh-git-branch-manage'])
    const dav = serve()
    await seedRemote(dav, {
      plugins: { dependencies: { 'dsh-git-branch-manage': '^1.0.2' }, bundles: ['@deepseek-ai/dsh-base', 'dsh-git-branch-manage'] },
    })
    const result = await sync(engineFor(paths, config()))
    expect(result.pendingInstall).toBe(false)
    expect(result.pendingNames).toBeUndefined()
    const shown = await status(engineFor(paths, config()))
    expect(shown.pendingInstall).toBe(false)
    expect(shown.pendingNames).toBeUndefined()
  })

  it('never counts a package that ships with dsh as missing', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    await fakeNodeModules(paths, [])
    const dav = serve()
    await seedRemote(dav, {
      plugins: {
        dependencies: {},
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-client-ui-settings'],
      },
    })
    const result = await sync(engineFor(paths, config()))
    expect(result.pendingInstall).toBe(false)
  })
})

describe('the cached copy', () => {
  it('is written after a push, and is the bytes the server holds', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    await sync(engineFor(paths, config()))
    const cachedBytes = await readFile(cacheFile(paths))
    const remoteBytes = dav.files.get(FILE_PATH)?.data as Uint8Array
    expect(cachedBytes.byteLength).toBe(remoteBytes.byteLength)
    expect(sum(new Uint8Array(cachedBytes))).toBe(sum(remoteBytes))
  })
})

describe('a passphrase that cannot seal anything', () => {
  it('is refused rather than sealed under a key anyone could derive', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    serve()
    await expect(sync(engineFor(paths, config({ passphrase: '   ' })))).rejects.toThrow(/还没有配置好/)
    await expect(seal({ a: 1 }, '   ')).rejects.toBeInstanceOf(Error)
  })

  it('seal and open round-trip a bundle, and a wrong passphrase is a PassphraseError', async () => {
    const bytes = await seal({ format: BUNDLE_FORMAT, value: 1 }, PASSPHRASE)
    const { open } = await import('../src/crypto.ts')
    expect(await open(bytes, PASSPHRASE)).toEqual({ format: BUNDLE_FORMAT, value: 1 })
    await expect(open(bytes, 'not it')).rejects.toBeInstanceOf(PassphraseError)
  })
})

describe('the profile files a sync reads', () => {
  it('reads a patch and a manifest into parts, with the file stamps', async () => {
    const paths = await writeProfile()
    const snapshot = await take(paths, config())
    expect(snapshot.parts.models).toBeDefined()
    expect(snapshot.parts.defaults).toBeDefined()
    expect(snapshot.parts.plugins).toBeDefined()
    expect(snapshot.parts.patch).toBeDefined()
    expect(snapshot.patch.mtimeMs).toBeGreaterThan(0)
    expect(snapshot.manifest.mtimeMs).toBeGreaterThan(0)
  })
})

describe('the extra directories', () => {
  /** A folder beside the profile holding the given files, keyed by `/`-separated path. */
  async function folder(files: Record<string, string>): Promise<string> {
    const root = await tempDir()
    for (const [path, text] of Object.entries(files)) {
      const file = join(root, ...path.split('/'))
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, text, 'utf8')
    }
    return root
  }

  /** The files one carried directory holds, as path → text. */
  function carried(bundle: Bundle, index = 0): Record<string, string> {
    const out: Record<string, string> = {}
    for (const file of bundle.dirs?.dirs[index]?.files ?? []) {
      out[file.path] = Buffer.from(file.data, 'base64').toString('utf8')
    }
    return out
  }

  /** The copies a sync kept for Undo, by kind, so a sync with nothing to say can be told apart. */
  async function kept(paths: ResolvedPaths, kind: string): Promise<string[]> {
    const names = await readdir(keptDir(paths)).catch(() => [] as string[])
    return names.filter((name) => name.includes(kind))
  }

  it('carries a configured directory into the sealed file', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const notes = await folder({ 'notes.md': '# mine', 'sub/one.txt': 'one' })
    const dav = serve()

    await sync(engineFor(paths, config({ dirs: [notes] })))

    const remote = await readRemote(dav)
    expect(remote.dirs?.dirs.map((dir) => dir.path)).toEqual([notes])
    expect(carried(remote)).toEqual({ 'notes.md': '# mine', 'sub/one.txt': 'one' })
  })

  it('restores the directory into the very folder it was named by', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const notes = await folder({ 'notes.md': '# mine' })
    const dav = serve()
    await sync(engineFor(paths, config({ dirs: [notes] })))

    // The folder is gone from this computer, and nothing names it any more: the
    // path in the part is the whole answer to where it goes back. That it is
    // merely absent rather than unreadable is what lets the restore create it.
    await rm(notes, { recursive: true, force: true })
    const result = await restore(engineFor(paths, config({ dirs: [notes] })))

    expect(result.here).toContain('dirs')
    expect(await readFile(join(notes, 'notes.md'), 'utf8')).toBe('# mine')
  })

  it('undo puts back the directory a restore replaced', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const notes = await folder({ 'notes.md': '# mine' })
    const dav = serve()
    const engine = engineFor(paths, config({ dirs: [notes] }))
    await sync(engine)
    await seedRemote(
      dav,
      { dirs: { dirs: [{ path: notes, files: [{ path: 'notes.md', data: Buffer.from('# theirs').toString('base64') }] }] } },
      new Date(Date.now() + 600_000).toISOString(),
    )

    await restore(engine)
    expect(await readFile(join(notes, 'notes.md'), 'utf8')).toBe('# theirs')

    await undo(engine)
    expect(await readFile(join(notes, 'notes.md'), 'utf8')).toBe('# mine')
  })

  it('never deletes a file from a directory a sync writes into', async () => {
    // Writing is additive on purpose: a file deleted on one computer comes back
    // from the others, because deleting inside somebody's own folder is the one
    // accident no notice could undo.
    const paths = await writeProfile(ONE_PROVIDER)
    const notes = await folder({ 'keep.txt': 'mine' })
    const dav = serve()

    await seedRemote(
      dav,
      {
        dirs: {
          dirs: [{ path: notes, files: [{ path: 'theirs.txt', data: Buffer.from('theirs').toString('base64') }] }],
        },
      },
      new Date(Date.now() + 600_000).toISOString(),
    )
    await sync(engineFor(paths, config({ dirs: [notes] })))

    expect(await readFile(join(notes, 'keep.txt'), 'utf8')).toBe('mine')
    expect(await readFile(join(notes, 'theirs.txt'), 'utf8')).toBe('theirs')
  })

  it('takes the server copy of a directory it can no longer read, instead of emptying it', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const notes = await folder({ 'notes.md': '# mine' })
    const dav = serve()
    await sync(engineFor(paths, config({ dirs: [notes] })))
    const theirs = await readRemote(dav)

    // The folder went away between two syncs. It must not be read as "a directory
    // with no files in it" — that would be pushed as a deletion of every file in
    // it — so the server's copy stands in for it, and what that copy holds is what
    // the next sync ends up writing: the folder comes back as it was.
    await rm(notes, { recursive: true, force: true })
    await sync(engineFor(paths, config({ dirs: [notes] })))

    expect(carried(await readRemote(dav))).toEqual(carried(theirs))
    expect(await readFile(join(notes, 'notes.md'), 'utf8')).toBe('# mine')
  })

  it('puts the directory back on a restore, with nothing synced in between', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const notes = await folder({ 'notes.md': '# mine' })
    const dav = serve()
    await sync(engineFor(paths, config({ dirs: [notes] })))

    // The path is named but nothing is there: "could not read" must not stop the
    // one write a restore is for, and the notice has to name the part it brought
    // in — which is the difference the button is chosen for.
    await rm(notes, { recursive: true, force: true })
    const result = await restore(engineFor(paths, config({ dirs: [notes] })))

    expect(result.here).toContain('dirs')
    expect(await readFile(join(notes, 'notes.md'), 'utf8')).toBe('# mine')
  })

  it('says on the status which configured directory it could not read', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    serve()
    const gone = join(await tempDir(), 'not-there')

    const view = await status(engineFor(paths, config({ dirs: [gone] })))
    expect(view.dirProblems?.map((problem) => problem.path)).toEqual([gone])
    expect(view.parts.map((part) => part.part)).toContain('dirs')
  })

  it('keeps no copy for Undo when the directories it was sent change nothing', async () => {
    // A computer that syncs no directories of its own is still sent somebody's —
    // that is how a restore lands — and a tree can run to megabytes. Sealing one
    // per sync, for a write that changes no file, is what this rules out.
    const paths = await writeProfile(ONE_PROVIDER)
    const notes = await folder({ 'notes.md': '# mine' })
    const dav = serve()

    // The computer that named the folder writes it and seals nothing.
    await sync(engineFor(paths, config({ dirs: [notes] })))
    expect(await kept(paths, 'before-apply')).toEqual([])
    expect(carried(await readRemote(dav))).toEqual({ 'notes.md': '# mine' })

    // A second computer, syncing no directories at all, is sent that folder and
    // writes it. The sync after that has nothing left to say and must seal nothing
    // new: a tree can run to megabytes and this one is sealed per write.
    const plain = await writeProfile(ONE_PROVIDER)
    const engine = engineFor(plain, config())
    await sync(engine)
    const sealed = (await kept(plain, 'before-apply')).length
    await sync(engine)

    expect((await kept(plain, 'before-apply')).length).toBe(sealed)
    expect(carried(await readRemote(dav))).toEqual({ 'notes.md': '# mine' })
  })

  it('stops syncing a directory taken off the list, and deletes nothing for it', async () => {
    // Removing a directory from the list is a statement about this computer, not
    // an instruction to delete files: the folder stays here, the server's copy
    // stays whole for the computers that still name it, and a later sync does not
    // quietly put it back from that copy either.
    const paths = await writeProfile(ONE_PROVIDER)
    const notes = await folder({ 'notes.md': '# mine' })
    const dav = serve()
    await sync(engineFor(paths, config({ dirs: [notes] })))

    const removed = await sync(engineFor(paths, config()))
    expect(removed.here).not.toContain('dirs')
    expect(removed.there).not.toContain('dirs')
    expect(await readFile(join(notes, 'notes.md'), 'utf8')).toBe('# mine')
    expect(carried(await readRemote(dav))).toEqual({ 'notes.md': '# mine' })

    // Nothing moved on the next one either — the list lives on the server, and this
    // computer has already said it does not want it.
    await sync(engineFor(paths, config()))
    expect(await readFile(join(notes, 'notes.md'), 'utf8')).toBe('# mine')
    expect(carried(await readRemote(dav))).toEqual({ 'notes.md': '# mine' })
  })

  it('never deletes a file when the part was taken away on the server', async () => {
    // The part can vanish from the sealed file — an older version this computer has
    // since moved away from wrote it without one. That reads as a removal, which is
    // how a row deleted elsewhere reaches this computer; a file inside somebody's own
    // directory is not a row, and the sync leaves it exactly where it is.
    const paths = await writeProfile(ONE_PROVIDER)
    const notes = await folder({ 'notes.md': '# mine' })
    const dav = serve()
    await sync(engineFor(paths, config({ dirs: [notes] })))

    const without = await readRemote(dav)
    delete without.dirs
    await seedRemote(dav, without)

    // This computer still names the folder, so it puts the part back up — and the
    // file that was already here is untouched by any of it.
    const result = await sync(engineFor(paths, config({ dirs: [notes] })))
    expect(result.there).toContain('dirs')
    expect(await readFile(join(notes, 'notes.md'), 'utf8')).toBe('# mine')
    expect(carried(await readRemote(dav))).toEqual({ 'notes.md': '# mine' })
  })

  it('walks none of the directories it is switched off for', async () => {
    // The switch says whether this computer carries the part at all, not which
    // folders are on it: with it off, no folder is read or written here, and the
    // copy the server holds travels through the push untouched.
    const paths = await writeProfile(ONE_PROVIDER)
    const notes = await folder({ 'notes.md': '# mine' })
    const dav = serve()
    await sync(engineFor(paths, config({ dirs: [notes] })))

    const second = await writeProfile(ONE_PROVIDER)
    await rm(notes, { recursive: true, force: true })
    const off = config({ dirs: [notes], dirsEnabled: false })
    await sync(engineFor(second, off))

    // Absent on this computer, and left absent: nothing wrote into it.
    expect(await readdir(notes).catch(() => null)).toBeNull()
    expect(carried(await readRemote(dav))).toEqual({ 'notes.md': '# mine' })

    const view = await status(engineFor(second, off))
    expect(view.parts.find((part) => part.part === 'dirs')?.synced).toBe(false)
    expect(view.config.dirsEnabled).toBe(false)
  })
})
