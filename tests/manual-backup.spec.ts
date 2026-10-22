/**
 * The manual backup: one file out, one file in.
 *
 * These actions sit beside the sync but never talk to the server, so every test
 * here runs against a profile on disk and a folder to write into — no WebDAV
 * stand-in. What matters is that the file a person carries is the same sealed
 * bundle the server holds, that the passphrase asked for is the one that opens
 * it, and that importing lands on a computer which has never synced at all.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUNDLE_APP, BUNDLE_FORMAT, BUNDLE_VERSION, type Bundle } from '../src/wire.ts'
import { open, seal } from '../src/crypto.ts'
import { engineFor, exportBackup, importBackup, sync } from '../src/engine.ts'
import { loadState } from '../src/state.ts'
import { collect, readManifest, readPatch } from '../src/store.ts'
import { FakeDav } from './fake-dav.ts'
import { cleanUp, configFor, tempDir, writeProfile, SAMPLE_MANIFEST, SAMPLE_PATCH } from './harness.ts'
import type { ResolvedPaths } from '../src/paths.ts'

const EXPORT_PASSPHRASE = 'the file passphrase'
const FILE_PATH = '/dav/dsh-webdav/dsh-profile.prop'

let stop: (() => void) | undefined

afterEach(async () => {
  stop?.()
  stop = undefined
  await cleanUp()
})

/** A fake server standing in for the remote, with the plugin's folder made. */
function serve(): FakeDav {
  const dav = new FakeDav()
  dav.seedCollection('/dav/dsh-webdav')
  stop = dav.use()
  return dav
}

/** The bundle the server holds now, opened with the sync passphrase. */
async function readRemote(dav: FakeDav): Promise<Bundle> {
  const bytes = dav.files.get(FILE_PATH)?.data
  expect(bytes).toBeDefined()
  return (await open(bytes as Uint8Array, 'a passphrase')) as Bundle
}

/** Read the one file an export wrote, opened with the passphrase it was sealed with. */
async function opened(file: string, passphrase = EXPORT_PASSPHRASE): Promise<Bundle> {
  return (await open(await readFile(file), passphrase)) as Bundle
}

/** A sealed bundle as text, the way the browser hands it over. */
async function sealedText(parts: Partial<Record<string, unknown>>, passphrase = EXPORT_PASSPHRASE): Promise<string> {
  const bundle: Bundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    created: new Date().toISOString(),
    app: BUNDLE_APP,
    ...(parts as Partial<Bundle>),
  }
  return Buffer.from(await seal(bundle, passphrase)).toString('utf8')
}

/** A profile whose model catalog names one provider. */
const ONE_PROVIDER = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      free:
        displayName: 免费
        apiKeyEnv: FREE_API_KEY

- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    defaultPreset: danger-full-access
`

/** Read a profile's patch text back. */
async function patchText(paths: ResolvedPaths): Promise<string> {
  return readFile(paths.patchFile, 'utf8')
}

describe('exporting a manual backup', () => {
  it('writes one sealed file into the folder it was given, and says what went in', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const folder = await tempDir('dsh-webdav-out-')

    const result = await exportBackup(engineFor(paths, configFor()), {
      passphrase: EXPORT_PASSPHRASE,
      dir: folder,
    })

    expect(result.file.startsWith(folder)).toBe(true)
    expect(result.file.endsWith('.prop')).toBe(true)
    expect(result.size).toBeGreaterThan(0)
    expect(result.parts).toEqual(expect.arrayContaining(['models', 'patch', 'plugins']))
    expect(await readdir(folder)).toEqual([result.file.slice(folder.length + 1)])

    const bundle = await opened(result.file)
    expect(bundle.format).toBe(BUNDLE_FORMAT)
    expect(JSON.stringify(bundle.models)).toContain('FREE_API_KEY')
    expect(JSON.stringify(bundle.plugins)).toContain('dsh-git-branch-manage')
  })

  it('takes a full file name as the file to write, and makes the folder for it', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const folder = await tempDir('dsh-webdav-out-')
    const file = join(folder, 'nested', 'mine.prop')

    const result = await exportBackup(engineFor(paths, configFor()), {
      passphrase: EXPORT_PASSPHRASE,
      dir: file,
    })

    expect(result.file).toBe(file)
    expect(JSON.stringify(await opened(file))).toContain('FREE_API_KEY')
  })

  it.each(['backup.v1', '.hidden-backups', 'nested/folder.with.dots'])('creates a dotted folder %s and writes a .prop file inside', async (name) => {
    const paths = await writeProfile(ONE_PROVIDER)
    const folder = join(await tempDir('dsh-webdav-out-'), name)
    const result = await exportBackup(engineFor(paths, configFor()), { passphrase: EXPORT_PASSPHRASE, dir: folder })
    expect(dirname(result.file)).toBe(folder)
    expect(await readdir(folder)).toHaveLength(1)
    expect((await opened(result.file)).format).toBe(BUNDLE_FORMAT)
  })

  it('keeps an existing .prop directory as a directory', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const folder = join(await tempDir('dsh-webdav-out-'), 'backups.prop')
    await mkdir(folder)
    const result = await exportBackup(engineFor(paths, configFor()), { passphrase: EXPORT_PASSPHRASE, dir: folder })
    expect(await readdir(folder)).toHaveLength(1)
    expect(await opened(result.file)).toHaveProperty('models')
  })

  it('uses distinct generated names for repeated exports', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const folder = await tempDir('dsh-webdav-out-')
    const engine = engineFor(paths, configFor())
    const a = await exportBackup(engine, { passphrase: EXPORT_PASSPHRASE, dir: folder })
    const b = await exportBackup(engine, { passphrase: EXPORT_PASSPHRASE, dir: folder })
    expect(a.file).not.toBe(b.file)
    expect(await readdir(folder)).toHaveLength(2)
  })

  it('never overwrites an existing explicit file', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const file = join(await tempDir('dsh-webdav-out-'), 'mine.prop')
    await writeFile(file, 'previous backup')
    await expect(exportBackup(engineFor(paths, configFor()), { passphrase: EXPORT_PASSPHRASE, dir: file })).rejects.toThrow(/已存在，不会覆盖/)
    expect(await readFile(file, 'utf8')).toBe('previous backup')
  })

  it('leaves out a part that is switched off, since that is the person saying it does not travel', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const folder = await tempDir('dsh-webdav-out-')

    const result = await exportBackup(engineFor(paths, configFor({ models: false })), {
      passphrase: EXPORT_PASSPHRASE,
      dir: folder,
    })

    expect(result.parts).not.toContain('models')
    const bundle = await opened(result.file)
    expect(bundle.models).toBeUndefined()
    expect(bundle.plugins).toBeDefined()
  })

  it('refuses a blank passphrase rather than writing a file nothing can open', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const folder = await tempDir('dsh-webdav-out-')

    await expect(
      exportBackup(engineFor(paths, configFor()), { passphrase: '   ', dir: folder }),
    ).rejects.toThrow(/导出需要一个口令/)
    expect(await readdir(folder)).toEqual([])
  })

  it('refuses a relative folder, which would mean a different place to the person typing it', async () => {
    const paths = await writeProfile(ONE_PROVIDER)

    await expect(
      exportBackup(engineFor(paths, configFor()), { passphrase: EXPORT_PASSPHRASE, dir: 'backups' }),
    ).rejects.toThrow(/必须是绝对路径/)
  })

  it('refuses when every part is switched off, so an empty file is never handed over', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const folder = await tempDir('dsh-webdav-out-')

    await expect(
      exportBackup(
        engineFor(paths, configFor({ models: false, plugins: false, patch: false, keys: false, dirsEnabled: false })),
        { passphrase: EXPORT_PASSPHRASE, dir: folder },
      ),
    ).rejects.toThrow(/没有可以导出的内容/)
  })
})

describe('importing a manual backup', () => {
  it('puts a setup onto a computer that has never synced, without any configuration', async () => {
    const paths = await writeProfile('')
    const text = await sealedText({
      models: { config: { providers: { theirs: { displayName: '他们的', apiKeyEnv: 'THEIRS' } } } },
      plugins: { dependencies: { 'dsh-git-branch-manage': '^1.0.2' }, bundles: ['@deepseek-ai/dsh-base'] },
    })

    // No address, no sync passphrase: this is exactly the machine the file is for.
    const engine = engineFor(paths, configFor({ url: '', passphrase: '' }))
    const result = await importBackup(engine, { passphrase: EXPORT_PASSPHRASE, text })

    expect(result.here).toEqual(expect.arrayContaining(['models', 'plugins']))
    expect(result.created).toBeTruthy()
    expect(await patchText(paths)).toContain('THEIRS')
    const manifest = JSON.parse(await readFile(paths.packageFile, 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(manifest.dependencies['dsh-git-branch-manage']).toBe('^1.0.2')
  })

  it('says the file changes nothing when this computer already holds what it carries', async () => {
    const paths = await writeProfile(SAMPLE_PATCH, SAMPLE_MANIFEST)
    const folder = await tempDir('dsh-webdav-out-')
    const exported = await exportBackup(engineFor(paths, configFor()), {
      passphrase: EXPORT_PASSPHRASE,
      dir: folder,
    })

    // The same file, back into the computer it came from: nothing to write.
    const result = await importBackup(engineFor(paths, configFor()), {
      passphrase: EXPORT_PASSPHRASE,
      text: await readFile(exported.file, 'utf8'),
    })

    expect(result.here).toEqual([])
    expect(result.same).toEqual(expect.arrayContaining(['models', 'patch', 'plugins']))
    expect(result.reloadNeeded).toBe(false)
  })

  it('keeps what it replaced when this computer has a passphrase to seal the copy with', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const text = await sealedText({ models: { config: { providers: { theirs: { id: 'theirs' } } } } })

    const result = await importBackup(engineFor(paths, configFor()), { passphrase: EXPORT_PASSPHRASE, text })

    expect(result.saved).toBeTruthy()
    const kept = await loadState(paths)
    // The folder is what the card reports; the file inside it is what undo reads.
    expect(kept.undo?.startsWith(result.saved as string)).toBe(true)
    expect(await patchText(paths)).toContain('theirs')
    // The copy on disk is a real backup of what was there: it opens with the sync
    // passphrase — the one this computer already had — and holds the old provider.
    const copy = await opened(kept.undo as string, 'a passphrase')
    expect(JSON.stringify(copy.models)).toContain('FREE_API_KEY')
  })

  it('leaves the sync baseline alone, so the next sync pushes the imported setup', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const dav = serve()
    const engine = engineFor(paths, configFor())
    await sync(engine)
    const before = await loadState(paths)

    const text = await sealedText({ models: { config: { providers: { theirs: { id: 'theirs' } } } } })
    await importBackup(engine, { passphrase: EXPORT_PASSPHRASE, text })

    // The stored hashes still describe the setup from before the import, so the
    // computer looks changed — which is what someone on a new machine wants.
    const after = await loadState(paths)
    expect(after.local).toEqual(before.local)
    const pushed = await sync(engineFor(paths, configFor()))
    // This computer changed, so the imported part travels out — `there`, not `here`.
    expect(pushed.there).toContain('models')
    expect(JSON.stringify(await readRemote(dav))).toContain('theirs')
  })

  it('refuses the wrong passphrase, and names the one that was used to export', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const text = await sealedText({ models: { config: { providers: { theirs: { id: 'theirs' } } } } })
    const before = await patchText(paths)

    await expect(
      importBackup(engineFor(paths, configFor()), { passphrase: 'not the one', text }),
    ).rejects.toThrow(/口令打不开这个文件/)
    // Nothing was written: a refused import is not a half-applied one.
    expect(await patchText(paths)).toBe(before)
  })

  it('refuses a file that is not one of ours, and says so rather than half-reading it', async () => {
    const paths = await writeProfile('')
    const engine = engineFor(paths, configFor())

    await expect(importBackup(engine, { passphrase: EXPORT_PASSPHRASE, text: '{"hello":true}' })).rejects.toThrow(
      /不是 dsh-webdav-sync 导出的备份/,
    )
    await expect(importBackup(engine, { passphrase: EXPORT_PASSPHRASE, text: '   ' })).rejects.toThrow(
      /没有读到文件内容/,
    )
    await expect(importBackup(engine, { passphrase: '', text: 'x' })).rejects.toThrow(/导入需要这个文件的口令/)
  })

  it('refuses a well-sealed file whose parts make no sense, instead of writing them', async () => {
    const paths = await writeProfile(ONE_PROVIDER)
    const text = await sealedText({ models: { config: 'not an object' } })
    const before = await patchText(paths)

    await expect(importBackup(engineFor(paths, configFor()), { passphrase: EXPORT_PASSPHRASE, text })).rejects.toThrow(
      /形状不是本插件写出来的/,
    )
    expect(await patchText(paths)).toBe(before)
  })

  it('round-trips the effective model order when both profiles have repeated overrides', async () => {
    const source = await writeProfile(`${SAMPLE_PATCH}
- id: llm-pi-ai
  config:
    providers:
      wb:
        models: [{ id: b }, { id: a }]
      free: {}
- id: llm-pi-ai
  disabled: false
`)
    const folder = await tempDir('dsh-webdav-order-')
    const exported = await exportBackup(engineFor(source, configFor()), {
      passphrase: EXPORT_PASSPHRASE,
      dir: folder,
    })
    const target = await writeProfile(`${SAMPLE_PATCH}\n- id: llm-pi-ai\n  config: {}\n- id: llm-pi-ai\n  disabled: false\n`)
    const engine = engineFor(target, configFor({ url: '', passphrase: '' }))
    const input = { passphrase: EXPORT_PASSPHRASE, text: await readFile(exported.file, 'utf8') }
    expect((await importBackup(engine, input)).here).toContain('models')
    const models = collect(await readPatch(target), await readManifest(target)).models
    const providers = models?.config.providers as Record<string, { models?: { id: string }[] }>
    expect(Object.keys(providers)).toEqual(['wb', 'free'])
    expect(providers.wb?.models?.map(model => model.id)).toEqual(['b', 'a'])
    expect(models).toEqual((await opened(exported.file)).models)
    const text = await patchText(target)
    expect((await importBackup(engine, input)).here).toEqual([])
    expect(await patchText(target)).toBe(text)
  })

  it('round-trips: what one computer exports, another imports', async () => {
    const source = await writeProfile(ONE_PROVIDER, SAMPLE_MANIFEST)
    const folder = await tempDir('dsh-webdav-out-')
    const exported = await exportBackup(engineFor(source, configFor()), {
      passphrase: EXPORT_PASSPHRASE,
      dir: folder,
    })

    // A second computer: its own manifest, so the plugins part has something to change.
    const target = await writeProfile('', `${JSON.stringify({ name: 'another-profile', private: true }, null, 2)}\n`)
    const result = await importBackup(engineFor(target, configFor({ url: '', passphrase: '' })), {
      passphrase: EXPORT_PASSPHRASE,
      text: await readFile(exported.file, 'utf8'),
    })

    expect(result.here).toEqual(expect.arrayContaining(['models', 'patch', 'plugins']))
    expect(await patchText(target)).toContain('FREE_API_KEY')
    expect(await patchText(target)).toContain('danger-full-access')
    expect((await readManifest(target)).text).toContain('dsh-git-branch-manage')
  })
})
