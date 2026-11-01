import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

// Only the separately captured 1.2.6 program modules and synthetic .verify homes.
// No engine, sync, status, credentials, network or encrypted-backup APIs are called.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureDir = join(repo, '.verify', 'webdav-1.2.6')
const originalPath = join(fixtureDir, 'plugin-config.original.js')
const patchedPath = join(fixtureDir, 'plugin-config.hardened.js')
const available = existsSync(originalPath) && existsSync(patchedPath)

type ConfigFile = { plugin: string; root: 'home' | 'profile'; path: string; data: string; modifiedAt: number }
type Paths = { homeDir: string; profileDir: string }
type ConfigRead = { files: ConfigFile[]; declarations: Omit<ConfigFile, 'data' | 'modifiedAt'>[]; versions: Record<string, string> }
type ConfigApi = {
  readPluginConfigs(paths: Paths, manifest: Record<string, unknown>): Promise<ConfigRead>
  mergeConfigFiles(local?: ConfigFile[], remote?: ConfigFile[]): ConfigFile[]
  applyPluginConfigs(paths: Paths, read: ConfigRead, part: { configFiles: ConfigFile[] }, before: () => Promise<void>): Promise<boolean>
}
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64')
const decode = (file: ConfigFile | undefined): unknown => {
  if (file === undefined) throw new Error('missing fixture config')
  return JSON.parse(Buffer.from(file.data, 'base64').toString('utf8'))
}
const file = (value: unknown, modifiedAt: number, name = 'key-index.json'): ConfigFile => ({
  plugin: 'dsh-model-think-level', root: 'home', path: `dsh-model-think-level/${name}`, data: encode(value), modifiedAt,
})
const full = () => ({
  version: 1,
  providers: { route: [{ ref: 'META_A', alias: '保留别名' }, { ref: 'META_B', alias: '备用' }], other: [{ ref: 'META_C' }] },
  endpoints: { route: { openai: 'https://local.invalid/v1' } },
  balances: { route: 'https://local.invalid/balance' },
})
const empty = () => ({
  version: 1, providers: {},
  endpoints: { route: { openai: 'https://winner.invalid/v1' } },
  balances: { route: 'https://winner.invalid/balance' },
})
const roots: string[] = []
let api: ConfigApi
let original: ConfigApi

async function home(value: unknown): Promise<{ paths: Paths; target: string }> {
  const root = await mkdtemp(join(fixtureDir, 'case-'))
  roots.push(root)
  const paths = { homeDir: join(root, 'home'), profileDir: join(root, 'profile') }
  await mkdir(join(paths.homeDir, 'dsh-model-think-level'), { recursive: true })
  await mkdir(paths.profileDir, { recursive: true })
  const target = join(paths.homeDir, 'dsh-model-think-level', 'key-index.json')
  await writeFile(target, JSON.stringify(value), 'utf8')
  return { paths, target }
}

describe.skipIf(!available)('captured WebDAV 1.2.6 module patch — no production IO', () => {
  beforeAll(async () => {
    const manifest = JSON.parse(await readFile(join(repo, 'src', 'key-index-plugin-config-patch.json'), 'utf8')) as {
      targetSha256: string; edits: { oldText: string; newText: string }[]
    }
    const baseline = await readFile(originalPath, 'utf8')
    expect(createHash('sha256').update(baseline).digest('hex')).toBe(manifest.targetSha256)
    let expected = baseline
    for (const edit of manifest.edits) {
      expect(expected.split(edit.oldText)).toHaveLength(2)
      expected = expected.replace(edit.oldText, edit.newText)
    }
    expect(await readFile(patchedPath, 'utf8')).toBe(expected)
    api = await import(pathToFileURL(patchedPath).href) as ConfigApi
    original = await import(pathToFileURL(originalPath).href) as ConfigApi
  })

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      const absolute = resolve(root)
      if (!absolute.startsWith(resolve(fixtureDir) + sep) || !absolute.startsWith(resolve(fixtureDir, 'case-'))) {
        throw new Error('refusing cleanup outside the synthetic fixture directory')
      }
      await rm(absolute, { recursive: true, force: true })
    }
  })

  it.each([10, 100])('keeps refs/aliases when empty remote has timestamp %i', remoteTime => {
    const local = file(full(), 90)
    const remote = file(empty(), remoteTime)
    const selected = decode(api.mergeConfigFiles([local], [remote])[0]) as ReturnType<typeof full>
    expect(selected.providers).toEqual(full().providers)
    expect(selected.endpoints).toEqual((remoteTime > 90 ? empty() : full()).endpoints)
    expect(selected.balances).toEqual((remoteTime > 90 ? empty() : full()).balances)
    if (remoteTime > 90) {
      expect(decode(original.mergeConfigFiles([local], [remote])[0])).toEqual(empty())
    }
  })

  it('unions fewer refs and fills only missing aliases in the preferred file', () => {
    const remote = file({ version: 1, providers: { route: [{ ref: 'META_A', disabled: true }] } }, 100)
    expect(decode(api.mergeConfigFiles([file(full(), 90)], [remote])[0])).toEqual({
      version: 1,
      providers: { route: [{ ref: 'META_A', disabled: true, alias: '保留别名' }, { ref: 'META_B', alias: '备用' }], other: [{ ref: 'META_C' }] },
    })
  })

  it('preserves the original equal-time hash winner and complete winner bytes', () => {
    const a = file(full(), 100)
    const b = file({ ...full(), providers: { ...full().providers, route: [{ ref: 'META_A', alias: '另一标签' }, { ref: 'META_B', alias: '备用' }] } }, 100)
    expect(api.mergeConfigFiles([a], [b])).toEqual(original.mergeConfigFiles([a], [b]))
    expect(api.mergeConfigFiles([], [a])).toEqual([a])
    expect(api.mergeConfigFiles([a], [])).toEqual([a])
  })

  it.each([
    ['future version', { version: 2, providers: {} }],
    ['array root', []],
    ['null providers', { version: 1, providers: null }],
    ['invalid ref', { version: 1, providers: { route: [{}] } }],
  ])('rejects %s on either side of normal selection', (_name, bad) => {
    expect(() => api.mergeConfigFiles([file(full(), 90)], [file(bad, 100)])).toThrow()
    expect(() => api.mergeConfigFiles([file(bad, 90)], [file(full(), 100)])).toThrow()
  })

  it('leaves non-key-index file selection and ui-order savedAt arbitration unchanged', () => {
    const imageA = file({ value: 'local' }, 100, 'image.json')
    const imageB = file({ value: 'remote' }, 200, 'image.json')
    expect(api.mergeConfigFiles([imageA], [imageB])).toEqual(original.mergeConfigFiles([imageA], [imageB]))
    const orderA = file({ version: 1, savedAt: 20, providerOrder: ['local'], modelOrder: {}, providersDisabled: [] }, 1, 'ui-order.json')
    const orderB = file({ version: 1, savedAt: 10, providerOrder: ['remote'], modelOrder: {}, providersDisabled: [] }, 999, 'ui-order.json')
    expect(api.mergeConfigFiles([orderA], [orderB])).toEqual([orderA])
    expect(api.mergeConfigFiles([orderA], [orderB])).toEqual(original.mergeConfigFiles([orderA], [orderB]))
  })

  it.each([10, Date.now() + 120_000])('protects direct overwrite against empty providers at mtime %i', async time => {
    const { paths, target } = await home(full())
    const read = await api.readPluginConfigs(paths, {})
    let backups = 0
    expect(await api.applyPluginConfigs(paths, read, { configFiles: [file(empty(), time)] }, async () => { backups += 1 })).toBe(true)
    const written = JSON.parse(await readFile(target, 'utf8')) as ReturnType<typeof full>
    expect(written.providers).toEqual(full().providers)
    expect(written.endpoints).toEqual(empty().endpoints)
    expect(written.balances).toEqual(empty().balances)
    expect(backups).toBe(1)
  })

  it('keeps a complete direct write a no-op when bytes already match', async () => {
    const { paths, target } = await home(full())
    const before = await readFile(target, 'utf8')
    const read = await api.readPluginConfigs(paths, {})
    let backups = 0
    expect(await api.applyPluginConfigs(paths, read, { configFiles: [file(full(), 100)] }, async () => { backups += 1 })).toBe(false)
    expect(await readFile(target, 'utf8')).toBe(before)
    expect(backups).toBe(0)
  })

  it('protects direct partial overwrite while accepting preferred non-empty alias/flags', async () => {
    const { paths, target } = await home(full())
    const read = await api.readPluginConfigs(paths, {})
    const preferred = { version: 1, providers: { route: [{ ref: 'META_A', alias: '新名称', disabled: true }] } }
    await api.applyPluginConfigs(paths, read, { configFiles: [file(preferred, 10)] }, async () => {})
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({
      version: 1,
      providers: { route: [{ ref: 'META_A', alias: '新名称', disabled: true }, { ref: 'META_B', alias: '备用' }], other: [{ ref: 'META_C' }] },
    })
  })

  it.each([
    ['future version', { version: 2, providers: {} }],
    ['array root', []],
    ['null providers', { version: 1, providers: null }],
    ['invalid ref', { version: 1, providers: { route: [{}] } }],
  ])('fails closed on %s during direct writes without backup or replacement', async (_name, bad) => {
    for (const badLocal of [false, true]) {
      const value = badLocal ? bad : full()
      const { paths, target } = await home(value)
      const before = await readFile(target, 'utf8')
      const read = await api.readPluginConfigs(paths, {})
      let backups = 0
      await expect(api.applyPluginConfigs(paths, read, { configFiles: [file(badLocal ? empty() : bad, 100)] }, async () => { backups += 1 })).rejects.toThrow()
      expect(await readFile(target, 'utf8')).toBe(before)
      expect(backups).toBe(0)
    }
  })

  it('retains backup failure and concurrent-edit guards', async () => {
    const { paths, target } = await home(full())
    let read = await api.readPluginConfigs(paths, {})
    const before = await readFile(target, 'utf8')
    await expect(api.applyPluginConfigs(paths, read, { configFiles: [file(empty(), 100)] }, async () => { throw new Error('fixture backup failure') })).rejects.toThrow('fixture backup failure')
    expect(await readFile(target, 'utf8')).toBe(before)
    read = await api.readPluginConfigs(paths, {})
    const concurrent = { ...full(), note: 'concurrent fixture edit' }
    await expect(api.applyPluginConfigs(paths, read, { configFiles: [file(empty(), 100)] }, async () => { await writeFile(target, JSON.stringify(concurrent), 'utf8') })).rejects.toThrow('备份期间插件配置已变化')
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(concurrent)
  })

  it('keeps ui-order rollback protection and allows non-key-index replacement', async () => {
    const { paths } = await home(full())
    const orderTarget = join(paths.homeDir, 'dsh-model-think-level', 'ui-order.json')
    const order = { version: 1, savedAt: 20, providerOrder: ['local'], modelOrder: {}, providersDisabled: [] }
    await writeFile(orderTarget, JSON.stringify(order), 'utf8')
    let read = await api.readPluginConfigs(paths, {})
    let backups = 0
    const older = file({ ...order, savedAt: 10, providerOrder: ['remote'] }, 999, 'ui-order.json')
    expect(await api.applyPluginConfigs(paths, read, { configFiles: [older] }, async () => { backups += 1 })).toBe(false)
    expect(JSON.parse(await readFile(orderTarget, 'utf8'))).toEqual(order)
    expect(backups).toBe(0)
    const imageTarget = join(paths.homeDir, 'dsh-model-think-level', 'image.json')
    await writeFile(imageTarget, JSON.stringify({ providers: { notMetadata: true } }), 'utf8')
    read = await api.readPluginConfigs(paths, {})
    expect(await api.applyPluginConfigs(paths, read, { configFiles: [file({ providers: {} }, 100, 'image.json')] }, async () => { backups += 1 })).toBe(true)
    expect(JSON.parse(await readFile(imageTarget, 'utf8'))).toEqual({ providers: {} })
    expect(backups).toBe(1)
  })
})
