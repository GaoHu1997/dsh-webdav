import { mkdir, readFile, readdir, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { open, seal } from '../src/crypto.ts'
import { engineFor, exportBackup, importBackup, pathsOf, preview, restore, sync, take, undo } from '../src/engine.ts'
import { applyPatch, readPatch } from '../src/store.ts'
import { applyPluginConfigs, CONFIG_MAX_FILE_BYTES, mergeConfigFiles, readPluginConfigs, validateConfigFiles } from '../src/plugin-config.ts'
import type { Bundle, PluginConfigFile } from '../src/wire.ts'
import type { KeysPort } from '../src/keys.ts'
import { FakeDav } from './fake-dav.ts'
import { cleanUp, configFor, tempDir } from './harness.ts'

const PLUGIN = 'dsh-model-think-level'
const REMOTE = '/dav/dsh-webdav/dsh-profile.prop'
const passphrase = 'a passphrase'
let stop: (() => void) | undefined
afterEach(async () => { stop?.(); stop = undefined; vi.restoreAllMocks(); await cleanUp() })
function serve(): FakeDav { const dav = new FakeDav(); dav.seedCollection('/dav/dsh-webdav'); stop = dav.use(); return dav }
function ui(savedAt: number, providerOrder = ['b', 'a']) {
  return { version: 1, savedAt, providerOrder, modelOrder: { b: ['two', 'one'] }, providersDisabled: ['a'] }
}
function configFile(name: string, value: unknown, modifiedAt = 1000): PluginConfigFile {
  return { plugin: PLUGIN, root: 'home', path: `${PLUGIN}/${name}`, data: Buffer.from(JSON.stringify(value)).toString('base64'), modifiedAt }
}
async function machine(over = {}, credentials?: KeysPort) {
  const home = await tempDir('config-home-')
  const profile = await tempDir('config-profile-')
  const paths = pathsOf(profile, home)
  await writeFile(paths.packageFile, JSON.stringify({ dependencies: { [PLUGIN]: '^1.0.0' } }))
  const engine = engineFor(paths, configFor({ keys: false, ...over }), credentials)
  return { home, paths, engine }
}
async function put(home: string, name: string, value: unknown, time?: number) {
  const file = join(home, PLUGIN, name)
  await mkdir(join(home, PLUGIN), { recursive: true })
  await writeFile(file, JSON.stringify(value))
  if (time !== undefined) await utimes(file, new Date(), new Date(time))
  return file
}
async function get(home: string, name: string) { return JSON.parse(await readFile(join(home, PLUGIN, name), 'utf8')) }
async function remote(dav: FakeDav): Promise<Bundle> { return await open(dav.files.get(REMOTE)!.data, passphrase) as Bundle }
async function seed(dav: FakeDav, bundle: Partial<Bundle>) {
  dav.seed(REMOTE, await seal({ format: 'dsh-webdav-sync-backup', version: 1, app: 'dsh-webdav-sync', created: new Date().toISOString(), ...bundle }, passphrase))
}

describe('automatic plugin settings', () => {
  it('previews and repairs a higher local savedAt retained after restoring an older server copy', async () => {
    const dav = serve(), m = await machine()
    await put(m.home, 'ui-order.json', ui(9000))
    await seed(dav, { plugins: { dependencies: { [PLUGIN]: '^1.0.0' }, bundles: [], configFiles: [configFile('ui-order.json', ui(1000))] } })
    await restore(m.engine)
    expect((await get(m.home, 'ui-order.json')).savedAt).toBe(9000)
    expect((await preview(m.engine)).changes).toContainEqual({ part: 'plugins', take: 'local' })
    expect((await sync(m.engine)).pushed).toBe(true)
    expect(JSON.parse(Buffer.from((await remote(dav)).plugins!.configFiles![0]!.data, 'base64').toString()).savedAt).toBe(9000)
  })

  it('applies the whitelist and plugin switch to a legacy extra directory', async () => {
    const m = await machine({ dirsEnabled: true, dirs: [`~/dsh-model-think-level`] })
    await put(m.home, 'key-index.json', { ref: 'KEY' })
    await put(m.home, 'key-serves.json', { cache: true })
    await put(m.home, 'log.json', { events: [] })
    expect((await take(m.paths, m.engine.config)).dirs.entries[0]?.files.map(f => f.path)).toEqual(['key-index.json'])
    m.engine.config.plugins = false
    expect((await take(m.paths, m.engine.config)).dirs.entries[0]?.files).toEqual([])
  })

  it('keeps local protected rows within mixed Loader insert blocks while applying safe rows', async () => {
    const m = await machine()
    await writeFile(m.paths.patchFile, '- insert:\n  - id: dsh-webdav-sync\n    config: { url: local }\n  - id: agent-default-model\n    config: { model: local }\n  - id: custom-ui\n    config: { color: old }\n')
    const snapshot = await readPatch(m.paths)
    const updated = applyPatch(snapshot, { patch: { entries: [{ insert: [
      { id: 'dsh-webdav-sync', config: { url: 'foreign' } },
      { id: 'agent-default-model', config: { model: 'foreign' } },
      { id: 'custom-ui', config: { color: 'new' } },
    ] } as never] } })
    expect(updated).toContain('url: local')
    expect(updated).toContain('model: local')
    expect(updated).toContain('color: new')
    expect(updated).not.toContain('foreign')
  })

  it('treats different pure provider reorders on both sides as a conflict, with identical preview and sync decisions', async () => {
    const dav = serve(), m = await machine()
    const patch = (names: string[]) => `- id: llm-pi-ai\n  config:\n    providers:\n${names.map(name => `      ${name}: { models: [{ id: same }] }`).join('\n')}\n`
    await writeFile(m.paths.patchFile, patch(['a', 'b', 'c']))
    await sync(m.engine)
    await writeFile(m.paths.patchFile, patch(['b', 'a', 'c']))
    await utimes(m.paths.patchFile, new Date(), new Date(1000))
    const previous = await remote(dav)
    await seed(dav, { ...previous, created: new Date(Date.now() + 10_000).toISOString(), models: {
      config: { providers: Object.fromEntries(['c', 'a', 'b'].map(name => [name, { models: [{ id: 'same' }] }])) },
    } })
    expect((await preview(m.engine)).changes).toContainEqual({ part: 'models', take: 'newer-remote' })
    const result = await sync(m.engine)
    expect(result.here).toContain('models')
    expect(result.saved).toBeDefined()
    expect(result.pushed).toBe(false)
    expect(Object.keys((await take(m.paths, m.engine.config)).parts.models!.config.providers as object)).toEqual(['c', 'a', 'b'])
    expect(Object.keys((await remote(dav)).models!.config.providers as object)).toEqual(['c', 'a', 'b'])
  })

  it('discovers an installed package declaration through an internal pnpm link', async () => {
    const m = await machine()
    const owner = 'other-plugin'
    await writeFile(m.paths.packageFile, JSON.stringify({ dependencies: { [owner]: '1' } }))
    const target = join(m.paths.profileDir, 'node_modules/.pnpm/other-plugin@1/node_modules/other-plugin')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'package.json'), JSON.stringify({ name: owner, dsh: { webdavSync: { configFiles: [{ root: 'home', path: `${owner}/settings.json` }] } } }))
    await symlink(target, join(m.paths.profileDir, 'node_modules', owner), 'junction')
    await mkdir(join(m.home, owner))
    await writeFile(join(m.home, owner, 'settings.json'), '{"enabled":true}')
    const snapshot = await take(m.paths, m.engine.config)
    expect(snapshot.parts.plugins?.configFiles?.[0]?.path).toBe('other-plugin/settings.json')
  })

  it('syncs all three settings across two homes with dirs disabled, excluding every runtime file', async () => {
    const dav = serve()
    const a = await machine(), b = await machine()
    await put(a.home, 'ui-order.json', ui(2000))
    const index = { version: 1, providers: { b: [{ ref: 'B_TWO', alias: 'second', models: ['two'] }] }, endpoints: { b: { openai: 'https://example.test/v1' } }, balances: { b: 'https://example.test/balance' } }
    await put(a.home, 'key-index.json', index)
    await put(a.home, 'image.json', { version: 2, defaultModel: 'b/image', models: [{ keyRef: 'IMAGE_KEY' }], outputDir: 'generated-images' })
    for (const name of ['key-serves.json', 'fingerprint.json', 'log.json', 'cache.json', 'history.json', 'state.json', 'data.db', 'a.tmp']) await put(a.home, name, { doNotCopy: true })
    expect(a.engine.config.dirsEnabled).toBe(false)
    expect((await preview(a.engine)).changes).toContainEqual({ part: 'plugins', take: 'local' })
    await sync(a.engine)
    const downloaded = await sync(b.engine)
    expect(downloaded.here).toContain('plugins')
    expect(await get(b.home, 'ui-order.json')).toEqual(ui(2000))
    expect(await get(b.home, 'key-index.json')).toEqual(index)
    expect(await readdir(join(b.home, PLUGIN))).toEqual(expect.arrayContaining(['ui-order.json', 'image.json', 'key-index.json']))
    expect((await readdir(join(b.home, PLUGIN))).length).toBe(3)
    const bundle = await remote(dav)
    expect(bundle.dirs).toBeUndefined()
    expect(bundle.plugins?.configFiles?.map(f => f.path)).toEqual([`${PLUGIN}/image.json`, `${PLUGIN}/key-index.json`, `${PLUGIN}/ui-order.json`])
    expect(JSON.stringify(bundle)).not.toContain(a.home)
    expect(bundle.keys).toBeUndefined()
    expect((await sync(b.engine)).pushed).toBe(false)
    expect((await preview(b.engine)).changes).toEqual([])
  })

  it('reads ref and keyRef credentials only through keys, and never resolves them with keys off', async () => {
    const dav = serve()
    const resolve = vi.fn(async (ref: string) => ({ value: `fixture-${ref}`, source: 'file' }))
    const store = vi.fn(async () => {})
    const a = await machine({ keys: true }, { resolve, store }), b = await machine({ keys: true }, { resolve: async () => undefined, store })
    await put(a.home, 'key-index.json', { providers: { a: [{ ref: 'MULTI_KEY' }] } })
    await put(a.home, 'image.json', { models: [{ keyRef: 'IMAGE_KEY' }], outputDir: 'images' })
    await sync(a.engine)
    expect((await remote(dav)).keys?.refs).toEqual({ IMAGE_KEY: 'fixture-IMAGE_KEY', MULTI_KEY: 'fixture-MULTI_KEY' })
    await sync(b.engine)
    expect(store).toHaveBeenCalledWith('IMAGE_KEY', 'fixture-IMAGE_KEY')
    resolve.mockClear()
    a.engine.config.keys = false
    const snapshot = await take(a.paths, a.engine.config, a.engine.credentials)
    expect(snapshot.parts.keys).toBeUndefined()
    expect(resolve).not.toHaveBeenCalled()
    const file = await exportBackup(a.engine, { passphrase, dir: await tempDir('out-') })
    const exported = await open(await readFile(file.file), passphrase) as Bundle
    expect(exported.keys).toBeUndefined()
    expect(JSON.stringify(exported.plugins)).not.toContain('fixture-')
  })

  it('takes the greater ui savedAt despite local mtime and remote envelope being newer', async () => {
    const dav = serve(), a = await machine(), b = await machine()
    await put(a.home, 'ui-order.json', ui(5000))
    await sync(a.engine); await sync(b.engine)
    await put(a.home, 'ui-order.json', ui(9000, ['a', 'b']), 1000)
    await put(b.home, 'ui-order.json', ui(7000, ['b', 'a']), Date.now() + 60_000)
    await sync(b.engine)
    expect((await preview(a.engine)).changes).toContainEqual({ part: 'plugins', take: 'newer-local' })
    await sync(a.engine); await sync(b.engine)
    expect(await get(a.home, 'ui-order.json')).toEqual(ui(9000, ['a', 'b']))
    expect(await get(b.home, 'ui-order.json')).toEqual(ui(9000, ['a', 'b']))
    // Explicit imports and undo cannot regress this last-writer-wins document either.
    const old = await seal({ format: 'dsh-webdav-sync-backup', version: 1, app: 'dsh-webdav-sync', created: new Date().toISOString(), plugins: { dependencies: {}, bundles: [], configFiles: [configFile('ui-order.json', ui(1000))] } }, passphrase)
    await importBackup(a.engine, { passphrase, text: Buffer.from(old).toString('utf8') })
    expect((await get(a.home, 'ui-order.json')).savedAt).toBe(9000)
  })

  it('does not delete remote config when local has no file, or local config when an old backup has no field', async () => {
    const dav = serve(), a = await machine(), b = await machine()
    await put(a.home, 'key-index.json', { providers: { a: [{ ref: 'A' }] } })
    await sync(a.engine); await sync(b.engine)
    await unlink(join(b.home, PLUGIN, 'key-index.json'))
    await sync(b.engine)
    expect((await remote(dav)).plugins?.configFiles).toHaveLength(1)
    await seed(dav, { plugins: { dependencies: { [PLUGIN]: '^1.0.0' }, bundles: [] } })
    await sync(a.engine)
    expect((await remote(dav)).plugins?.configFiles).toHaveLength(1)
    const old = await seal({ format: 'dsh-webdav-sync-backup', version: 1, app: 'dsh-webdav-sync', created: new Date().toISOString(), plugins: { dependencies: {}, bundles: [] } }, passphrase)
    await importBackup(a.engine, { passphrase, text: Buffer.from(old).toString('utf8') })
    expect((await get(a.home, 'key-index.json')).providers.a[0].ref).toBe('A')
  })

  it('backs up plugin settings for restore and undo, and obeys switches for import/export/restore/undo', async () => {
    const dav = serve(), a = await machine(), b = await machine()
    await put(a.home, 'key-index.json', { selected: 'remote' })
    await put(b.home, 'key-index.json', { selected: 'local' })
    await sync(a.engine)
    const restored = await restore(b.engine)
    expect(restored.saved).toBeDefined()
    expect(await get(b.home, 'key-index.json')).toEqual({ selected: 'remote' })
    await undo(b.engine)
    expect(await get(b.home, 'key-index.json')).toEqual({ selected: 'local' })
    b.engine.config.plugins = false
    expect((await preview(b.engine)).changes.some(c => c.part === 'plugins')).toBe(false)
    await restore(b.engine)
    expect(await get(b.home, 'key-index.json')).toEqual({ selected: 'local' })
    await importBackup(b.engine, { passphrase, text: Buffer.from(dav.files.get(REMOTE)!.data).toString('utf8') })
    expect(await get(b.home, 'key-index.json')).toEqual({ selected: 'local' })
    await undo(b.engine)
    expect(await get(b.home, 'key-index.json')).toEqual({ selected: 'local' })
    await expect(exportBackup(b.engine, { passphrase, dir: await tempDir('disabled-out-') })).rejects.toThrow(/没有可以导出/)
    expect((await take(b.paths, b.engine.config)).parts.plugins?.configFiles).toBeUndefined()
  })

  it('maps image outputDir inside home/profile to the target and preserves unrelated per-machine paths', async () => {
    const dav = serve(), a = await machine(), b = await machine()
    await put(a.home, 'image.json', { outputDir: join(a.home, 'generated'), models: [] })
    await sync(a.engine); await sync(b.engine)
    expect((await get(b.home, 'image.json')).outputDir).toBe(join(b.home, 'generated'))
    expect(JSON.stringify(await remote(dav))).not.toContain(a.home)
    await put(a.home, 'image.json', { outputDir: join(a.paths.profileDir, 'images'), models: [] })
    await sync(a.engine); await sync(b.engine)
    expect((await get(b.home, 'image.json')).outputDir).toBe(join(b.paths.profileDir, 'images'))
  })

  it('supports locally declared home and profile settings for other plugins without remote write authority', async () => {
    const dav = serve(), a = await machine(), b = await machine()
    const manifest = { dependencies: { 'example-plugin': '1' }, dsh: { webdavSync: { configFiles: [
      { plugin: 'example-plugin', root: 'home', path: 'example-plugin/options.json' },
      { plugin: 'example-plugin', root: 'profile', path: 'example-plugin/ui.json' },
    ] } } }
    for (const m of [a, b]) await writeFile(m.paths.packageFile, JSON.stringify(manifest))
    await mkdir(join(a.home, 'example-plugin')); await mkdir(join(a.paths.profileDir, 'example-plugin'))
    await writeFile(join(a.home, 'example-plugin/options.json'), '{"color":"green"}')
    await writeFile(join(a.paths.profileDir, 'example-plugin/ui.json'), '{"size":12}')
    await sync(a.engine); await sync(b.engine)
    expect(await readFile(join(b.home, 'example-plugin/options.json'), 'utf8')).toBe('{"color":"green"}')
    expect(await readFile(join(b.paths.profileDir, 'example-plugin/ui.json'), 'utf8')).toBe('{"size":12}')
    const c = await machine()
    await sync(c.engine)
    await expect(readFile(join(c.home, 'example-plugin/options.json'))).rejects.toThrow()
    // The remote declaration was not written into c's manifest; settings stay carried.
    expect((await remote(dav)).plugins?.configFiles).toHaveLength(2)
  })

  it('keeps effective home Loader config while preserving self/default and old backups without home entries', async () => {
    const dav = serve(), a = await machine(), b = await machine()
    await writeFile(a.paths.patchFile, '- id: ui-chat\n  config: { color: profile }\n')
    await writeFile(a.paths.homePatchFile!, '- id: ui-chat\n  config: { color: home }\n- id: dsh-webdav-sync\n  config: { url: local-a }\n- id: agent-default-model\n  config: { model: local-a }\n')
    await writeFile(b.paths.homePatchFile!, '- id: dsh-webdav-sync\n  config: { url: local-b }\n- id: agent-default-model\n  config: { model: local-b }\n')
    await sync(a.engine); await sync(b.engine)
    const home = await readFile(b.paths.homePatchFile!, 'utf8')
    expect(home).toContain('color: home'); expect(home).toContain('url: local-b'); expect(home).toContain('model: local-b')
    expect(home).not.toContain('local-a')
    const bundle = await remote(dav)
    expect(bundle.patch?.homeEntries).toHaveLength(1)
    await seed(dav, { patch: { entries: [{ id: 'ui-chat', config: { color: 'legacy' } }] } })
    await sync(b.engine)
    expect(await readFile(b.paths.homePatchFile!, 'utf8')).toContain('color: home')
    await seed(dav, { plugins: { dependencies: { [PLUGIN]: '^1.0.0' }, bundles: [] } })
    await sync(b.engine)
    expect(await readFile(b.paths.patchFile, 'utf8')).not.toContain('id: ui-chat')
    expect(await readFile(b.paths.homePatchFile!, 'utf8')).toContain('color: home')
  })

  it('restores settings a pre-configFiles backup carried inside a directory, without rolling ui-order back', async () => {
    const dav = serve(), m = await machine({ dirsEnabled: true })
    await put(m.home, 'ui-order.json', ui(9000))
    const data = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64')
    await seed(dav, { dirs: { dirs: [{ path: '~/dsh-model-think-level', files: [
      { path: 'key-index.json', data: data({ providers: { relay: [{ ref: 'KEY' }] } }) },
      { path: 'ui-order.json', data: data(ui(1000)) },
      { path: 'key-serves.json', data: data({ providers: {} }) },
    ] }] } })
    await restore(m.engine)
    expect((await get(m.home, 'key-index.json')).providers.relay[0].ref).toBe('KEY')
    expect((await get(m.home, 'ui-order.json')).savedAt).toBe(9000)
    await expect(readFile(join(m.home, PLUGIN, 'key-serves.json'), 'utf8')).rejects.toThrow()
  })

  it('carries the deleted last home Loader row as an explicit empty answer, not as an old backup', async () => {
    const dav = serve(), a = await machine(), b = await machine()
    await writeFile(a.paths.homePatchFile!, '- id: ui-chat\n  config: { color: home }\n')
    await sync(a.engine)
    await sync(b.engine)
    expect(await readFile(b.paths.homePatchFile!, 'utf8')).toContain('color: home')
    expect((await remote(dav)).patch?.homeEntries).toHaveLength(1)
    await writeFile(a.paths.homePatchFile!, '[]\n')
    await sync(a.engine)
    await sync(b.engine)
    expect(await readFile(b.paths.homePatchFile!, 'utf8')).not.toContain('color: home')
    expect((await remote(dav)).patch?.homeEntries).toEqual([])
  })
})

describe('plugin config safety', () => {
  it('refuses an unsafe path in an encrypted import before writing any settings', async () => {
    const m = await machine()
    await put(m.home, 'image.json', { retained: true })
    const bad = await seal({ format: 'dsh-webdav-sync-backup', version: 1, app: 'dsh-webdav-sync', created: new Date().toISOString(), plugins: {
      dependencies: {}, bundles: [], configFiles: [{ ...configFile('image.json', {}), path: `${PLUGIN}\\..\\evil.json` }],
    } }, passphrase)
    await expect(importBackup(m.engine, { passphrase, text: Buffer.from(bad).toString() })).rejects.toThrow(/plugins/)
    expect(await get(m.home, 'image.json')).toEqual({ retained: true })
  })

  it('rejects an oversized local file and declarations for caches', async () => {
    const m = await machine()
    const file = await put(m.home, 'image.json', {})
    await writeFile(file, Buffer.alloc(CONFIG_MAX_FILE_BYTES + 1))
    await expect(readPluginConfigs(m.paths, {})).rejects.toThrow(/读取上限/)
    await expect(readPluginConfigs(m.paths, { dsh: { webdavSync: { configFiles: [{ plugin: PLUGIN, root: 'home', path: `${PLUGIN}/fingerprint.json` }] } } })).rejects.toThrow(/声明/)
  })

  it.each(['../evil.json', 'dsh-model-think-level/../../evil.json', 'dsh-model-think-level\\..\\evil.json', 'C:/evil.json', '//server/a.json', 'dsh-model-think-level/key-serves.json', 'dsh-model-think-level/fingerprint.json', 'dsh-model-think-level/logs/a.json', 'dsh-model-think-level/.credentials.json', 'dsh-model-think-level/CON.json', 'dsh-model-think-level/a.json:stream'])('rejects unsafe config path %s', path => {
    expect(() => validateConfigFiles([{ ...configFile('image.json', {}), path }])).toThrow()
  })
  it('rejects oversized/duplicate/non-JSON/inline credential content before writes', () => {
    const file = configFile('image.json', {})
    expect(() => validateConfigFiles([configFile('image.json', { blob: 'x'.repeat(CONFIG_MAX_FILE_BYTES - 100) })])).not.toThrow()
    expect(() => validateConfigFiles([file, file])).toThrow()
    expect(() => validateConfigFiles([{ ...file, data: Buffer.alloc(CONFIG_MAX_FILE_BYTES + 1).toString('base64') }])).toThrow()
    expect(() => validateConfigFiles([configFile('image.json', { apiKey: 'fixture-secret' })])).toThrow()
    expect(() => validateConfigFiles([{ ...file, data: 'not-base64' }])).toThrow()
  })
  it('rejects a junction directory during reads and writes', async () => {
    const m = await machine(), outside = await tempDir('junction-target-')
    await writeFile(join(outside, 'image.json'), '{}')
    await symlink(outside, join(m.home, PLUGIN), 'junction')
    await expect(readPluginConfigs(m.paths, {})).rejects.toThrow(/符号链接|重解析/)
    const read = await readPluginConfigs(pathsOf(m.paths.profileDir), {})
    await expect(applyPluginConfigs(m.paths, read, { dependencies: {}, bundles: [], configFiles: [configFile('image.json', {})] }, async () => {})).rejects.toThrow(/符号链接|重解析/)
    expect(await readFile(join(outside, 'image.json'), 'utf8')).toBe('{}')
  })
  it('refuses both a mutation before applying and one during the backup window', async () => {
    const m = await machine()
    const file = await put(m.home, 'image.json', { original: true })
    const snapshot = await readPluginConfigs(m.paths, {})
    const part = { dependencies: {}, bundles: [], configFiles: [configFile('image.json', { incoming: true })] }
    await writeFile(file, '{"edited":true}')
    await expect(applyPluginConfigs(m.paths, snapshot, part, async () => {})).rejects.toThrow(/已变化/)
    const fresh = await readPluginConfigs(m.paths, {})
    await expect(applyPluginConfigs(m.paths, fresh, part, async () => { await writeFile(file, '{"duringBackup":true}') })).rejects.toThrow(/已变化/)
    expect(await get(m.home, 'image.json')).toEqual({ duringBackup: true })
  })
  it('aborts when backup fails and keeps absent files and equal-stamp ties deterministic', async () => {
    const m = await machine()
    await put(m.home, 'image.json', { original: true })
    const read = await readPluginConfigs(m.paths, {})
    await expect(applyPluginConfigs(m.paths, read, { dependencies: {}, bundles: [], configFiles: [configFile('image.json', {})] }, async () => { throw new Error('backup failed') })).rejects.toThrow('backup failed')
    expect(await get(m.home, 'image.json')).toEqual({ original: true })
    const a = configFile('ui-order.json', ui(1000, ['a'])), b = configFile('ui-order.json', ui(1000, ['b']))
    expect(mergeConfigFiles([a], [b])).toEqual(mergeConfigFiles([b], [a]))
    expect(mergeConfigFiles([], [a])).toEqual([a])
  })
})
