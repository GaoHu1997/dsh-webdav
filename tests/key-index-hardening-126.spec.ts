import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

// The WebDAV release program and the independent model queue share this realm.
// The captured model queue imports a throwing pure path stub, never the real index.
// Every mutation below uses an explicit .verify toy target. No Workers/process locks,
// engine/status/sync/config APIs, credential values or encrypted backups are used.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureDir = join(repo, '.verify', 'webdav-1.2.6')
const originalPath = join(fixtureDir, 'plugin-config.original.js')
const patchedPath = join(fixtureDir, 'plugin-config.hardened.js')
const modelDir = join(fixtureDir, 'model-queue')
const available = [originalPath, patchedPath, join(fixtureDir, 'key-mutation-queue.js'), join(modelDir, 'key-mutation-queue.js'), join(modelDir, 'key-refs.js')].every(existsSync)

const MODEL = 'dsh-model-think-level'
const INDEX = `${MODEL}/key-index.json`
const QUEUES = Symbol.for('dsh-model-think-level.key-mutation-queues')
type ConfigFile = { plugin: string; root: 'home' | 'profile'; path: string; data: string; modifiedAt: number }
type Paths = { homeDir: string; profileDir: string }
type Declaration = Omit<ConfigFile, 'data' | 'modifiedAt'>
type ConfigRead = { files: ConfigFile[]; declarations: Declaration[]; versions: Record<string, string> }
type ConfigApi = {
  validateConfigFiles(files: unknown): void
  readPluginConfigs(paths: Paths, manifest: Record<string, unknown>): Promise<ConfigRead>
  mergeConfigFiles(local?: ConfigFile[], remote?: ConfigFile[]): ConfigFile[]
  applyPluginConfigs(paths: Paths, read: ConfigRead, part: { configFiles: ConfigFile[] }, before: () => Promise<void>): Promise<boolean>
}
type QueueApi = { acquireKeyMutation(file: string): Promise<() => void>; keyMutationTarget(file: string): string }
type AliasApi = { normalizeKeyAlias(value: unknown): string | undefined; KEY_ALIAS_MAX_LENGTH: number }
type Index = { version: 1; providers: Record<string, { ref: string; alias?: string; [key: string]: unknown }[]>; endpoints?: Record<string, Record<string, string>>; [key: string]: unknown }
let api: ConfigApi
let modelQueue: Pick<QueueApi, 'acquireKeyMutation'>
let webdavQueue: QueueApi
let host: AliasApi
const roots: string[] = []
const releases: (() => void)[] = []
const tasks: Promise<unknown>[] = []
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64')
const decode = (file: ConfigFile | undefined): Index => {
  if (file === undefined) throw new Error('missing synthetic config')
  return JSON.parse(Buffer.from(file.data, 'base64').toString('utf8'))
}
const config = (value: unknown, time = 100, extra: Partial<ConfigFile> = {}): ConfigFile => ({ plugin: MODEL, root: 'home', path: INDEX, data: encode(value), modifiedAt: time, ...extra })
const full = (): Index => ({
  version: 1,
  providers: { route: [{ ref: 'META_A', alias: 'saved label' }, { ref: 'META_B', alias: 'spare' }], extra: [{ ref: 'META_C' }] },
  endpoints: { route: { openai: 'https://local.invalid/v1' } },
})
const empty = (): Index => ({ version: 1, providers: {}, endpoints: { route: { openai: 'https://winner.invalid/v1' } } })
const manifest = (...items: Declaration[]): Record<string, unknown> => ({ dsh: { webdavSync: { configFiles: items } } })
const declaration = (extra: Partial<Declaration> = {}): Declaration => ({ plugin: MODEL, root: 'home', path: INDEX, ...extra })
const queueMap = (): Map<string, Promise<void>> => {
  const map = (globalThis as unknown as Record<symbol, Map<string, Promise<void>> | undefined>)[QUEUES]
  if (map === undefined) throw new Error('shared queue registry is missing')
  return map
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let done: () => void = () => {}
  const promise = new Promise<void>(resolve => { done = resolve })
  return { promise, resolve: done }
}
function track<T>(task: Promise<T>): Promise<T> {
  tasks.push(task)
  void task.catch(() => {})
  return task
}
async function home(value: unknown = full()): Promise<{ paths: Paths; target: string; root: string }> {
  const root = await mkdtemp(join(fixtureDir, 'hardening-case-'))
  roots.push(root)
  const paths = { homeDir: join(root, 'home'), profileDir: join(root, 'profile') }
  await mkdir(join(paths.homeDir, MODEL), { recursive: true })
  await mkdir(paths.profileDir, { recursive: true })
  const target = join(paths.homeDir, INDEX)
  await writeFile(target, JSON.stringify(value), 'utf8')
  return { paths, target, root }
}
async function readIndex(target: string): Promise<Index> {
  return JSON.parse(await readFile(target, 'utf8'))
}

// Captured suites must really run at acceptance time; missing fixtures are explicit skips.
describe.skipIf(!available)('exact WebDAV 1.2.6 canonical index and shared model lease', () => {
  beforeAll(async () => {
    const patch = JSON.parse(await readFile(join(repo, 'src', 'key-index-plugin-config-patch.json'), 'utf8')) as {
      targetSha256: string; candidateFile: string; queueFile: string; edits: { oldText: string; newText: string }[]
    }
    const baseline = await readFile(originalPath, 'utf8')
    expect(createHash('sha256').update(baseline).digest('hex')).toBe('53547f3c17aee30bfe0993bed940a27d57d0e0a5616960dad2079719c31a5c4e')
    expect(patch.targetSha256).toBe(createHash('sha256').update(baseline).digest('hex'))
    expect(resolve(repo, patch.candidateFile)).toBe(patchedPath)
    expect(patch.queueFile).toBe('lib/key-mutation-queue.js')
    let expected = baseline
    for (const edit of patch.edits) {
      expect(baseline.split(edit.oldText)).toHaveLength(2)
      expect(expected.split(edit.oldText)).toHaveLength(2)
      expected = expected.replace(edit.oldText, edit.newText)
    }
    expect(await readFile(patchedPath, 'utf8')).toBe(expected)
    const queueSource = await readFile(join(modelDir, 'key-mutation-queue.ts'), 'utf8')
    expect(createHash('sha256').update(queueSource).digest('hex')).toBe('11079a5ea718133271f1a033973395480ad16dd02ea5230cea69621523778222')
    const aliasSource = await readFile(join(modelDir, 'key-refs.ts'), 'utf8')
    expect(createHash('sha256').update(aliasSource).digest('hex')).toBe('79532f7a60f199d50005afdea7541c035fff423ee047fc6bccc381fb2a44fc5c')
    api = await import(pathToFileURL(patchedPath).href) as ConfigApi
    webdavQueue = await import(pathToFileURL(join(fixtureDir, 'key-mutation-queue.js')).href) as QueueApi
    modelQueue = await import(pathToFileURL(join(modelDir, 'key-mutation-queue.js')).href) as Pick<QueueApi, 'acquireKeyMutation'>
    host = await import(pathToFileURL(join(modelDir, 'key-refs.js')).href) as AliasApi
    expect(host.KEY_ALIAS_MAX_LENGTH).toBe(40)
  })

  afterEach(async () => {
    for (const release of releases.splice(0).reverse()) release()
    await Promise.allSettled(tasks.splice(0))
    for (const root of roots.splice(0)) {
      const absolute = resolve(root)
      if (!absolute.startsWith(resolve(fixtureDir) + sep) || !absolute.startsWith(resolve(fixtureDir, 'hardening-case-'))) {
        throw new Error('refusing cleanup outside the synthetic hardening directory')
      }
      await rm(absolute, { recursive: true, force: true })
    }
  })

  it.each(['\u0000', '\u007f', '\u0000\u0001\u007f \t', '\u0000 visible\u007f ', '  ' + 'x'.repeat(60) + '\t', '  ' + '🙂'.repeat(30) + '\u0000'])('matches the captured host alias visibility for %j', winner => {
    const alternate = ' \u0000fallback\t '
    const preferred = { version: 1, providers: { route: [{ ref: 'META_A', alias: winner, disabled: true, models: [] }] } }
    const other = { version: 1, providers: { route: [{ ref: 'META_A', alias: alternate, disabled: false }] } }
    const selected = decode(api.mergeConfigFiles([config(other, 90)], [config(preferred, 100)])[0])
    const alias = selected.providers.route?.[0]?.alias
    const visibleWinner = host.normalizeKeyAlias(winner)
    expect(alias).toBe(visibleWinner === undefined ? alternate : winner)
    expect(host.normalizeKeyAlias(alias)).toBe(visibleWinner ?? host.normalizeKeyAlias(alternate))
    expect(host.normalizeKeyAlias(alias)?.length).toBeLessThanOrEqual(40)
    expect(selected.providers.route?.[0]).toEqual({ ref: 'META_A', alias, disabled: true, models: [] })
    const once = api.mergeConfigFiles([], [config(selected, 100)])
    expect(api.mergeConfigFiles([config(other, 90)], once)).toEqual(once)
  })

  it.each(['\u0000', '\u007f', '\u0000\u0001\u007f \t'])('restores a visible alias on an actual direct write with winner %j', async alias => {
    const { paths, target } = await home()
    const read = await api.readPluginConfigs(paths, {})
    const incoming = full()
    incoming.providers.route = [{ ref: 'META_A', alias, disabled: true, models: [] }]
    incoming.note = 'synthetic direct alias regression'
    await api.applyPluginConfigs(paths, read, { configFiles: [config(incoming)] }, async () => {})
    const written = await readIndex(target)
    expect(host.normalizeKeyAlias(written.providers.route?.[0]?.alias)).toBe('saved label')
    expect(written.providers.route?.[0]).toEqual({ ref: 'META_A', alias: 'saved label', disabled: true, models: [] })
    expect(written.providers.route?.map(entry => entry.ref)).toEqual(['META_A', 'META_B'])
  })

  it.each([['array-home', ['home']], ['array-profile', ['profile']], ['null', null], ['boolean', true], ['number', 0], ['object', { value: 'home' }], ['boxed-string', new String('home')]])('rejects non-string wrapper root %s before any backup or write', async (_name, root) => {
    const { paths, target } = await home()
    const read = await api.readPluginConfigs(paths, {})
    const bad = { ...config(empty()), root } as unknown as ConfigFile
    expect(() => api.validateConfigFiles([bad])).toThrow('插件配置路径或元数据无效')
    expect(() => api.mergeConfigFiles([config(full(), 1000)], [bad])).toThrow('插件配置路径或元数据无效')
    let backups = 0
    await expect(api.applyPluginConfigs(paths, read, { configFiles: [bad] }, async () => { backups += 1 })).rejects.toThrow('插件配置路径或元数据无效')
    expect(backups).toBe(0)
    expect(await readIndex(target)).toEqual(full())
  })

  it('rejects root coercion in the local declaration authority too', async () => {
    const { paths } = await home()
    const bad = { plugin: MODEL, root: ['home'], path: INDEX }
    await expect(api.readPluginConfigs(paths, manifest(bad as unknown as Declaration))).rejects.toThrow('插件配置声明必须是插件命名空间')
  })

  it('protects scoped-owner home selection without promoting undeclared ownership', async () => {
    const owner = '@scope/dsh-model-think-level'
    const selected = decode(api.mergeConfigFiles([config(full(), 90, { plugin: owner })], [config(empty(), 100, { plugin: owner })])[0])
    expect(selected.providers).toEqual(full().providers)
    expect(selected.endpoints).toEqual(empty().endpoints)
    const { paths, target } = await home()
    let read = await api.readPluginConfigs(paths, {})
    let backups = 0
    expect(await api.applyPluginConfigs(paths, read, { configFiles: [config(empty(), 100, { plugin: owner })] }, async () => { backups += 1 })).toBe(false)
    expect(backups).toBe(0)
    expect(await readIndex(target)).toEqual(full())
    read = await api.readPluginConfigs(paths, manifest(declaration({ plugin: owner })))
    expect(await api.applyPluginConfigs(paths, read, { configFiles: [config(empty(), 100, { plugin: owner })] }, async () => { backups += 1 })).toBe(true)
    expect((await readIndex(target)).providers).toEqual(full().providers)
    expect(backups).toBe(1)
  })

  it.each(['same-root', 'ancestor-root'])('protects the actual home index reached via %s profile topology', async topology => {
    const { paths, target, root } = await home()
    const extra = topology === 'same-root' ? declaration({ root: 'profile' }) : declaration({ plugin: 'home', root: 'profile', path: `home/${INDEX}` })
    paths.profileDir = topology === 'same-root' ? paths.homeDir : root
    const read = await api.readPluginConfigs(paths, manifest(extra))
    const incoming = config(empty(), 100, extra)
    let backups = 0
    expect(await api.applyPluginConfigs(paths, read, { configFiles: [incoming] }, async () => { backups += 1 })).toBe(true)
    expect((await readIndex(target)).providers).toEqual(full().providers)
    expect((await readIndex(target)).endpoints).toEqual(empty().endpoints)
    expect(backups).toBe(1)
  })

  it('does not add key-index semantics to a distinct profile file with the same basename', async () => {
    const { paths, target } = await home()
    await mkdir(join(paths.profileDir, MODEL), { recursive: true })
    const profileTarget = join(paths.profileDir, INDEX)
    await writeFile(profileTarget, JSON.stringify({ old: true }), 'utf8')
    const extra = declaration({ root: 'profile' })
    const read = await api.readPluginConfigs(paths, manifest(extra))
    const incoming = config({ arbitrary: 'non-index setting' }, 100, extra)
    expect(await api.applyPluginConfigs(paths, read, { configFiles: [incoming] }, async () => {})).toBe(true)
    expect(JSON.parse(await readFile(profileTarget, 'utf8'))).toEqual({ arbitrary: 'non-index setting' })
    expect(await readIndex(target)).toEqual(full())
  })

  it('makes two authorized names for the physical index one complete backup/commit', async () => {
    const { paths, target } = await home()
    const owner = '@scope/dsh-model-think-level'
    const read = await api.readPluginConfigs(paths, manifest(declaration({ plugin: owner })))
    const older = config({ version: 1, providers: { route: [{ ref: 'META_A', alias: 'changed', disabled: true }] } }, 10)
    const newer = config({ version: 1, providers: { route: [{ ref: 'META_X', alias: 'added' }] }, endpoints: empty().endpoints }, 20, { plugin: owner })
    let backups = 0
    expect(await api.applyPluginConfigs(paths, read, { configFiles: [older, newer] }, async () => { backups += 1 })).toBe(true)
    const written = await readIndex(target)
    expect(written.providers.route?.map(entry => entry.ref)).toEqual(['META_X', 'META_A', 'META_B'])
    expect(written.providers.extra).toEqual(full().providers.extra)
    expect(written.providers.route?.find(entry => entry.ref === 'META_A')).toEqual({ ref: 'META_A', alias: 'changed', disabled: true })
    expect(written.endpoints).toEqual(empty().endpoints)
    expect(backups).toBe(1)
  })

  it('rejects a stale version for any authorized alias before making a partial commit', async () => {
    const { paths, target } = await home()
    const extra = declaration({ plugin: '@scope/dsh-model-think-level' })
    const read = await api.readPluginConfigs(paths, manifest(extra))
    read.versions[`${extra.plugin}:${extra.root}:${extra.path}`] = 'stale synthetic version'
    let backups = 0
    await expect(api.applyPluginConfigs(paths, read, { configFiles: [config(empty()), config(full(), 10, extra)] }, async () => { backups += 1 })).rejects.toThrow('插件配置在同步期间已变化')
    expect(backups).toBe(0)
    expect(await readIndex(target)).toEqual(full())
  })

  it.each(['scoped-owner', 'same-root'])('does not launder a future document through the %s target alias', async kind => {
    const { paths, target } = await home()
    const extra = kind === 'scoped-owner' ? declaration({ plugin: '@scope/dsh-model-think-level' }) : declaration({ root: 'profile' })
    if (kind === 'same-root') paths.profileDir = paths.homeDir
    const read = await api.readPluginConfigs(paths, manifest(extra))
    let backups = 0
    await expect(api.applyPluginConfigs(paths, read, { configFiles: [config({ version: 2, providers: {} }, 100, extra)] }, async () => { backups += 1 })).rejects.toThrow('key-index 元数据无效')
    expect(backups).toBe(0)
    expect(await readIndex(target)).toEqual(full())
    expect(queueMap().has(webdavQueue.keyMutationTarget(target))).toBe(false)
  })

  it('waits for a model lease before current-read/backup and refuses its now-stale snapshot', async () => {
    const { paths, target } = await home()
    const read = await api.readPluginConfigs(paths, {})
    const release = await modelQueue.acquireKeyMutation(target)
    releases.push(release)
    const key = webdavQueue.keyMutationTarget(target)
    const modelTurn = queueMap().get(key)
    let backups = 0
    const applying = track(api.applyPluginConfigs(paths, read, { configFiles: [config(empty())] }, async () => { backups += 1 }))
    // Acquiring the queue must be the first async step, before readBounded can run.
    expect(queueMap().get(key)).not.toBe(modelTurn)
    await Promise.resolve()
    expect(backups).toBe(0)
    expect(await readIndex(target)).toEqual(full())
    const modelWritten = full()
    modelWritten.providers.route?.push({ ref: 'META_MODEL', alias: 'model commit' })
    await writeFile(target, JSON.stringify(modelWritten), 'utf8')
    release()
    await expect(applying).rejects.toThrow('插件配置在同步期间已变化')
    expect(backups).toBe(0)
    expect(await readIndex(target)).toEqual(modelWritten)
    expect(queueMap().has(key)).toBe(false)
  })

  it('keeps a model mutation waiting through the WebDAV backup and actual rename', async () => {
    const { paths, target } = await home()
    const read = await api.readPluginConfigs(paths, {})
    const started = deferred()
    const resume = deferred()
    releases.push(resume.resolve)
    const applying = track(api.applyPluginConfigs(paths, read, { configFiles: [config(empty())] }, async () => { started.resolve(); await resume.promise }))
    await started.promise
    const key = webdavQueue.keyMutationTarget(target)
    const syncTurn = queueMap().get(key)
    expect(syncTurn).toBeDefined()
    let acquired = false
    let modelSaw: Index | undefined
    const modelWriting = track((async () => {
      const release = await modelQueue.acquireKeyMutation(target)
      releases.push(release)
      try {
        acquired = true
        modelSaw = await readIndex(target)
        const next = await readIndex(target)
        next.providers.route?.push({ ref: 'META_MODEL', alias: 'after sync' })
        await writeFile(target, JSON.stringify(next), 'utf8')
      } finally { release() }
    })())
    expect(queueMap().get(key)).not.toBe(syncTurn)
    await Promise.resolve()
    expect(acquired).toBe(false)
    expect(await readIndex(target)).toEqual(full())
    resume.resolve()
    expect(await applying).toBe(true)
    await modelWriting
    expect(modelSaw?.providers).toEqual(full().providers)
    expect(modelSaw?.endpoints).toEqual(empty().endpoints)
    expect((await readIndex(target)).providers.route?.map(entry => entry.ref)).toEqual(['META_A', 'META_B', 'META_MODEL'])
    expect(queueMap().has(key)).toBe(false)
  })

  it('releases the lease on backup failure and leaves the index untouched', async () => {
    const { paths, target } = await home()
    const read = await api.readPluginConfigs(paths, {})
    await expect(api.applyPluginConfigs(paths, read, { configFiles: [config(empty())] }, async () => { throw new Error('synthetic backup failure') })).rejects.toThrow('synthetic backup failure')
    expect(await readIndex(target)).toEqual(full())
    expect(queueMap().has(webdavQueue.keyMutationTarget(target))).toBe(false)
    const release = await modelQueue.acquireKeyMutation(target)
    releases.push(release)
    release()
  })

  it('leaves non-index replacement independent of an outstanding model index lease', async () => {
    const { paths, target } = await home()
    const imageTarget = join(paths.homeDir, MODEL, 'image.json')
    await writeFile(imageTarget, JSON.stringify({ old: true }), 'utf8')
    const read = await api.readPluginConfigs(paths, {})
    const release = await modelQueue.acquireKeyMutation(target)
    releases.push(release)
    try {
      const incoming = config({ newSetting: true }, 100, { path: `${MODEL}/image.json` })
      expect(await api.applyPluginConfigs(paths, read, { configFiles: [incoming] }, async () => {})).toBe(true)
      expect(JSON.parse(await readFile(imageTarget, 'utf8'))).toEqual({ newSetting: true })
    } finally { release() }
  })

  it('shares FIFO and idempotent release with an independent captured model queue', async () => {
    const { target } = await home()
    const releaseFirst = await modelQueue.acquireKeyMutation(target)
    releases.push(releaseFirst)
    const order: string[] = []
    const second = track(webdavQueue.acquireKeyMutation(target).then(release => { order.push('webdav'); releases.push(release); return release }))
    let thirdAcquired = false
    const third = track(modelQueue.acquireKeyMutation(target).then(release => { order.push('model'); thirdAcquired = true; releases.push(release); return release }))
    await Promise.resolve()
    expect(order).toEqual([])
    releaseFirst()
    releaseFirst()
    const releaseSecond = await second
    expect(order).toEqual(['webdav'])
    expect(thirdAcquired).toBe(false)
    releaseSecond()
    releaseSecond()
    const releaseThird = await third
    expect(order).toEqual(['webdav', 'model'])
    releaseThird()
    expect(queueMap().has(webdavQueue.keyMutationTarget(target))).toBe(false)
  })

  it('matches the model Windows casefold and never serializes different index targets', async () => {
    const { target } = await home()
    const absolute = resolve(target)
    expect(webdavQueue.keyMutationTarget(target)).toBe(process.platform === 'win32' ? absolute.toLowerCase() : absolute)
    const release = await modelQueue.acquireKeyMutation(target)
    releases.push(release)
    const independent = await webdavQueue.acquireKeyMutation(join(dirname(target), 'other-index.json'))
    releases.push(independent)
    independent()
    const alternate = target.toUpperCase()
    if (process.platform === 'win32') {
      let acquired = false
      const pending = track(webdavQueue.acquireKeyMutation(alternate).then(next => { acquired = true; releases.push(next); return next }))
      await Promise.resolve()
      expect(acquired).toBe(false)
      release()
      const next = await pending
      next()
    } else {
      expect(webdavQueue.keyMutationTarget(alternate)).not.toBe(webdavQueue.keyMutationTarget(target))
      const next = await webdavQueue.acquireKeyMutation(alternate)
      releases.push(next)
      next()
      release()
    }
  })
})
