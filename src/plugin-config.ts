/** Explicit settings only: no recursive JSON discovery and no remote path authority. */
import { constants } from 'node:fs'
import { lstat, open, mkdir, rename, unlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { randomUUID } from 'node:crypto'
import { hashJson } from './crypto.js'
import { isMissing, isPlainObject } from './store.js'
import type { ResolvedPaths } from './paths.js'
import type { PluginConfigFile, PluginsPart } from './wire.js'

export const CONFIG_MAX_FILES = 128
export const CONFIG_MAX_FILE_BYTES = 1024 * 1024
export const CONFIG_MAX_BYTES = 8 * 1024 * 1024
type Declaration = Pick<PluginConfigFile, 'plugin' | 'root' | 'path'>
export interface ConfigRead { files: PluginConfigFile[]; declarations: Declaration[]; versions: Record<string, string> }
const MODEL_PLUGIN = 'dsh-model-think-level'
const BUILTIN: Declaration[] = ['ui-order.json', 'key-index.json', 'image.json'].map(name => ({
  plugin: MODEL_PLUGIN, root: 'home', path: `${MODEL_PLUGIN}/${name}`,
}))
const FORBIDDEN = /(^|[._-])(logs?|caches?|history|histories|sessions?|telemetry|temp|tmp|database|db|runtime|state|backups?|credentials?|secrets?|tokens?|password|passphrase|sync|key-serves|fingerprint|node_modules)([._-]|$)/i

function packageName(name: unknown): name is string {
  return typeof name === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name)
    && !name.split('/').some(s => s === '.' || s === '..') && name !== 'dsh-webdav-sync'
}
function declaration(value: unknown): value is Declaration {
  if (!isPlainObject(value) || !packageName(value.plugin) || !['home', 'profile'].includes(String(value.root))) return false
  if (typeof value.path !== 'string' || value.path.length > 240 || !value.path.endsWith('.json')) return false
  const segments = value.path.split('/')
  return segments.length >= 2 && segments[0] === value.plugin.split('/').at(-1)
    && segments.every(s => /^[a-z0-9][a-z0-9._-]*$/.test(s) && !s.endsWith('.')
      && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s) && !FORBIDDEN.test(s))
}
export function configKey(file: Declaration): string { return `${file.plugin}:${file.root}:${file.path}` }
function rootOf(paths: ResolvedPaths, file: Declaration): string | undefined {
  return file.root === 'home' ? paths.homeDir : paths.profileDir
}

/** Reject symlinks/junctions in every ancestor, including the configured root. */
async function safePath(file: string, create = false): Promise<void> {
  const parent = dirname(file)
  if (parent !== file) await safePath(parent, create)
  let info
  try { info = await lstat(file) } catch (cause) {
    if (!isMissing(cause)) throw cause
    if (create) {
      await mkdir(file, { mode: 0o700 }).catch(async cause => {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
      })
      info = await lstat(file)
    } else return
  }
  if (info.isSymbolicLink() || !info.isDirectory() || resolve(await realpath(file)).toLowerCase() !== resolve(file).toLowerCase()) {
    throw new Error('插件配置路径包含符号链接、重解析路径或非目录')
  }
}

/** Read through a checked handle with a hard cap, then recheck path and identity. */
async function readBounded(file: string, maxBytes = CONFIG_MAX_FILE_BYTES): Promise<{ bytes: Buffer; modifiedAt: number; signature: string } | undefined> {
  await safePath(dirname(file))
  let before
  try { before = await lstat(file) } catch (cause) { if (isMissing(cause)) return undefined; throw cause }
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error('插件配置不是普通文件或超过读取上限')
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev) throw new Error('读取插件配置时文件已变化')
    const buffer = Buffer.alloc(maxBytes + 1)
    let size = 0
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null)
      if (read.bytesRead === 0) break
      size += read.bytesRead
    }
    if (size > maxBytes) throw new Error('插件配置超过读取上限')
    const after = await handle.stat()
    await safePath(dirname(file))
    const pathInfo = await lstat(file)
    if (pathInfo.isSymbolicLink() || pathInfo.ino !== info.ino || pathInfo.dev !== info.dev || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
      throw new Error('读取插件配置时文件已变化')
    }
    const bytes = buffer.subarray(0, size)
    return { bytes, modifiedAt: info.mtimeMs, signature: hashJson([info.dev, info.ino, info.mtimeMs, info.ctimeMs, bytes.toString('base64')]) }
  } finally { await handle.close() }
}

function jsonData(data: string): unknown {
  if (typeof data !== 'string' || data.length > Math.ceil(CONFIG_MAX_FILE_BYTES / 3) * 4) throw new Error('插件配置编码或大小无效')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.toString('base64') !== data) throw new Error('插件配置编码无效')
  if (bytes.length > CONFIG_MAX_FILE_BYTES) throw new Error('插件配置超过 1 MiB')
  const parsed: unknown = JSON.parse(bytes.toString('utf8'))
  if (!isPlainObject(parsed) && !Array.isArray(parsed)) throw new Error('插件配置必须是 JSON 对象或数组')
  const checkSecrets = (value: unknown, depth: number): void => {
    if (depth > 64) throw new Error('插件配置嵌套超过上限')
    if (value === null || typeof value !== 'object') return
    for (const [key, held] of Object.entries(value)) {
      if (/^(apiKey|accessToken|password|passphrase|secret|token|authorization)$/i.test(key) && typeof held === 'string' && held !== '') throw new Error('插件配置包含内联凭据，请改用凭据引用')
      checkSecrets(held, depth + 1)
    }
  }
  checkSecrets(parsed, 0)
  return parsed
}

/** The image output path is a setting with machine-local absolute spellings. */
function portableData(file: Declaration, data: string, paths: ResolvedPaths): string {
  if (file.plugin !== MODEL_PLUGIN || file.path !== `${MODEL_PLUGIN}/image.json`) return data
  const value = jsonData(data)
  if (!isPlainObject(value) || typeof value.outputDir !== 'string' || (!isAbsolute(value.outputDir) && !win32.isAbsolute(value.outputDir))) return data
  for (const [marker, root] of [['$DSH_PROFILE_DIR', paths.profileDir], ['$DSH_HOME', paths.homeDir]] as const) {
    if (root === undefined) continue
    const suffix = relative(root, value.outputDir)
    if (suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix))) {
      return Buffer.from(JSON.stringify({ ...value, outputDir: `${marker}/${suffix.split(sep).join('/')}` })).toString('base64')
    }
  }
  return Buffer.from(JSON.stringify({ ...value, outputDir: '$LOCAL_IMAGE_OUTPUT_DIR' })).toString('base64')
}
function localData(file: PluginConfigFile, current: string | undefined, paths: ResolvedPaths): string {
  if (file.plugin !== MODEL_PLUGIN || file.path !== `${MODEL_PLUGIN}/image.json`) return file.data
  const value = jsonData(file.data)
  if (!isPlainObject(value) || typeof value.outputDir !== 'string') return file.data
  let outputDir = value.outputDir
  if (outputDir === '$LOCAL_IMAGE_OUTPUT_DIR') {
    const prior = current === undefined ? undefined : jsonData(current)
    outputDir = isPlainObject(prior) && typeof prior.outputDir === 'string' ? prior.outputDir : 'generated-images'
  } else {
    for (const [marker, root] of [['$DSH_PROFILE_DIR', paths.profileDir], ['$DSH_HOME', paths.homeDir]] as const) {
      if (!outputDir.startsWith(marker + '/')) continue
      if (root === undefined) throw new Error('这台电脑没有插件配置所需的 DSH 主目录')
      const suffix = outputDir.slice(marker.length + 1)
      if (suffix.split(/[\\/]/).some(s => s === '..' || s === '.') || /[:\u0000]/.test(suffix) || isAbsolute(suffix) || win32.isAbsolute(suffix)) throw new Error('生图输出目录映射无效')
      outputDir = join(root, suffix)
      break
    }
    if (outputDir === value.outputDir && (isAbsolute(outputDir) || win32.isAbsolute(outputDir))) throw new Error('备份中的生图输出目录必须可移植')
  }
  return outputDir === value.outputDir ? file.data : Buffer.from(JSON.stringify({ ...value, outputDir })).toString('base64')
}
function stamp(file: PluginConfigFile): number {
  if (file.plugin === MODEL_PLUGIN && file.path === `${MODEL_PLUGIN}/ui-order.json`) {
    const value = jsonData(file.data)
    if (!isPlainObject(value) || value.version !== 1 || !Number.isFinite(value.savedAt) || Number(value.savedAt) < 0 || Number(value.savedAt) > 8.64e15
      || !Array.isArray(value.providerOrder) || !value.providerOrder.every(s => typeof s === 'string')
      || !isPlainObject(value.modelOrder) || !Object.values(value.modelOrder).every(v => Array.isArray(v) && v.every(s => typeof s === 'string'))
      || !Array.isArray(value.providersDisabled) || !value.providersDisabled.every(s => typeof s === 'string')) throw new Error('ui-order.json 格式无效')
    return Number(value.savedAt)
  }
  return file.modifiedAt
}
export function validateConfigFiles(value: unknown): asserts value is PluginConfigFile[] {
  if (!Array.isArray(value) || value.length > CONFIG_MAX_FILES) throw new Error('插件配置文件清单无效或超过上限')
  let bytes = 0
  const keys = new Set<string>()
  for (const file of value) {
    if (!isPlainObject(file) || typeof file.data !== 'string' || typeof file.modifiedAt !== 'number' || !Number.isFinite(file.modifiedAt) || file.modifiedAt < 0 || file.modifiedAt > 8.64e15 || !declaration(file)) throw new Error('插件配置路径或元数据无效')
    const held = file as PluginConfigFile
    jsonData(held.data)
    stamp(held)
    bytes += Buffer.from(held.data, 'base64').length
    const key = configKey(file)
    if (keys.has(key) || bytes > CONFIG_MAX_BYTES) throw new Error('插件配置重复或超过 8 MiB')
    keys.add(key)
  }
}

/** Local profile/package declarations are the authority; remote declarations never are. */
export async function readPluginConfigs(paths: ResolvedPaths, manifest: Record<string, unknown>, enabled = true): Promise<ConfigRead> {
  const declarations = new Map(BUILTIN.map(d => [configKey(d), d]))
  const add = (owner: string, value: unknown): void => {
    if (value === undefined) return
    if (!Array.isArray(value)) throw new Error('dsh.webdavSync.configFiles 必须是清单')
    for (const entry of value) {
      const item = isPlainObject(entry) ? { ...entry, plugin: owner } : undefined
      if (!declaration(item)) throw new Error('插件配置声明必须是插件命名空间内的显式 JSON 配置路径')
      declarations.set(configKey(item), item)
      if (declarations.size > CONFIG_MAX_FILES) throw new Error('插件配置声明超过上限')
    }
  }
  const dsh = isPlainObject(manifest.dsh) ? manifest.dsh : {}
  const profileDeclarations = isPlainObject(dsh.webdavSync) ? dsh.webdavSync.configFiles : undefined
  if (profileDeclarations !== undefined) {
    if (!Array.isArray(profileDeclarations)) throw new Error('profile 插件配置声明必须是清单')
    for (const entry of profileDeclarations) {
      if (!isPlainObject(entry) || !packageName(entry.plugin)) throw new Error('profile 插件配置声明无效')
      add(entry.plugin, [entry])
    }
  }
  const dependencies = isPlainObject(manifest.dependencies) ? manifest.dependencies : {}
  const profile = isPlainObject(dsh.profile) ? dsh.profile : {}
  const owners = new Set([...Object.keys(dependencies), ...(Array.isArray(profile.bundles) ? profile.bundles : [])])
  for (const owner of owners) {
    if (!packageName(owner)) continue
    // Only declared packages' package.json, never a walk of node_modules.
    // pnpm metadata links may resolve inside this profile's node_modules;
    // configuration data paths never follow links, and external package links
    // need the explicit local profile declaration instead.
    const file = join(paths.profileDir, 'node_modules', owner, 'package.json')
    let held
    try {
      const canonical = await realpath(file)
      if (!resolve(canonical).toLowerCase().startsWith(resolve(paths.profileDir, 'node_modules').toLowerCase() + sep)) continue
      held = await readBounded(canonical)
      if (await realpath(file) !== canonical) throw new Error('插件声明读取期间已变化')
    } catch { continue }
    if (held === undefined) continue
    const packageJson: unknown = JSON.parse(held.bytes.toString('utf8'))
    if (!isPlainObject(packageJson) || packageJson.name !== owner || !isPlainObject(packageJson.dsh) || !isPlainObject(packageJson.dsh.webdavSync)) continue
    add(owner, packageJson.dsh.webdavSync.configFiles)
  }
  const files: PluginConfigFile[] = []
  const versions: Record<string, string> = {}
  if (!enabled) return { files, declarations: [...declarations.values()], versions }
  let bytes = 0
  for (const item of declarations.values()) {
    const root = rootOf(paths, item)
    if (root === undefined) continue
    const held = await readBounded(join(root, item.path), Math.min(CONFIG_MAX_FILE_BYTES, CONFIG_MAX_BYTES - bytes))
    if (held === undefined) continue
    bytes += held.bytes.length
    const file = { ...item, data: portableData(item, held.bytes.toString('base64'), paths), modifiedAt: held.modifiedAt }
    file.modifiedAt = stamp(file)
    files.push(file)
    versions[configKey(file)] = held.signature
  }
  validateConfigFiles(files)
  return { files: files.sort((a, b) => configKey(a).localeCompare(configKey(b))), declarations: [...declarations.values()], versions }
}

/**
 * Legacy explicit dirs inside a settings namespace still obey its whitelist.
 *
 * Only an exactly declared config path (or one of its parent directories) may
 * pass; caches, logs and every other file of the namespace are still refused.
 * `writing` names the configs an operation is already writing through
 * {@link applyPluginConfigs}: those are dropped from the directory copy so the
 * same file is not written twice with two different arbitration rules. An
 * operation that writes no plugin configs at all — restoring a backup made
 * before this part existed — lets the declared paths through, which is what puts
 * a legacy `~/<plugin>/key-index.json` back on disk.
 */
export function includePluginPath(paths: ResolvedPaths, read: ConfigRead, file: string, enabled: boolean, writing: ReadonlySet<string> = new Set()): boolean {
  const candidate = resolve(file).toLowerCase()
  for (const item of read.declarations) {
    const root = rootOf(paths, item)
    if (root === undefined) continue
    const namespace = resolve(root, item.path.split('/')[0]!).toLowerCase()
    if (candidate === namespace || candidate.startsWith(namespace + sep)) {
      if (!enabled) return false
      return read.declarations.some(d => {
        if (writing.has(configKey(d))) return false
        const base = rootOf(paths, d)
        if (base === undefined) return false
        const target = resolve(base, d.path).toLowerCase()
        return candidate === target || target.startsWith(candidate + sep)
      })
    }
  }
  return true
}

/**
 * Settings a pre-`plugins.configFiles` backup carried inside a named directory.
 *
 * A backup made before this part existed travels its plugin settings as ordinary
 * directory files. Restoring it must not silently drop them, but it also must not
 * write `ui-order.json` straight over a newer document. Each matching file is
 * therefore handed to {@link applyPluginConfigs} — the path that already knows
 * the `savedAt` rule and the backup-before-write rule — instead of being written
 * as a directory file. Files that are not declared settings are left to the
 * directory copy, and a file this computer cannot represent portably is skipped
 * rather than written somewhere else.
 */
export function adoptLegacyConfigs(
  paths: ResolvedPaths,
  read: ConfigRead,
  files: readonly { path: string; data: string }[],
  now = Date.now(),
): PluginConfigFile[] {
  const out: PluginConfigFile[] = []
  for (const file of files) {
    const target = resolve(file.path).toLowerCase()
    const declaration = read.declarations.find(d => {
      const root = rootOf(paths, d)
      return root !== undefined && resolve(root, d.path).toLowerCase() === target
    })
    if (declaration === undefined) continue
    try {
      const item: PluginConfigFile = { ...declaration, data: file.data, modifiedAt: now }
      item.data = localData(item, undefined, paths)
      validateConfigFiles([item])
      out.push(item)
    } catch {
      // A legacy copy this build cannot represent safely is left alone.
    }
  }
  return out.sort((a, b) => configKey(a).localeCompare(configKey(b)))
}

/** Modification timestamps arbitrate files; ui-order uses its own savedAt. */
export function mergeConfigFiles(local: PluginConfigFile[] = [], remote: PluginConfigFile[] = []): PluginConfigFile[] {
  const merged = new Map(remote.map(file => [configKey(file), file]))
  for (const file of local) {
    const other = merged.get(configKey(file))
    if (other === undefined || stamp(file) > stamp(other) || (stamp(file) === stamp(other) && hashJson(file.data) > hashJson(other.data))) merged.set(configKey(file), file)
  }
  const files = [...merged.values()].sort((a, b) => configKey(a).localeCompare(configKey(b)))
  validateConfigFiles(files)
  return files
}
/** Physical mtimes after applying a file do not constitute another configuration edit. */
export function pluginsIdentity(value: unknown): unknown {
  if (!isPlainObject(value) || !Array.isArray(value.configFiles)) return value
  return { ...value, configFiles: value.configFiles.map(({ modifiedAt: _time, ...file }: PluginConfigFile) => file) }
}

/** Plan before any write, then re-read before and after the backup/KDF window. */
export async function applyPluginConfigs(paths: ResolvedPaths, read: ConfigRead, part: PluginsPart, before: () => Promise<void>): Promise<boolean> {
  const files = part.configFiles ?? []
  validateConfigFiles(files)
  const allowed = new Set(read.declarations.map(configKey))
  const pending: { file: PluginConfigFile; target: string; signature: string | undefined; data: string }[] = []
  let bytes = 0
  for (const file of files) {
    if (!allowed.has(configKey(file))) continue // preserved on wire, no local authorization to write it
    const root = rootOf(paths, file)
    if (root === undefined) continue
    const target = join(root, file.path)
    const current = await readBounded(target, Math.min(CONFIG_MAX_FILE_BYTES, CONFIG_MAX_BYTES - bytes))
    bytes += current?.bytes.length ?? 0
    const data = current?.bytes.toString('base64')
    const portable = data === undefined ? undefined : portableData(file, data, paths)
    const desired = localData(file, data, paths)
    if (portable === file.data) continue
    if (current?.signature !== read.versions[configKey(file)]) throw new Error('插件配置在同步期间已变化，请重试')
    // Even explicit restore/import/undo must not roll the UI document backwards.
    if (data !== undefined && file.path === `${MODEL_PLUGIN}/ui-order.json` && stamp({ ...file, data }) > stamp(file)) continue
    pending.push({ file, target, signature: current?.signature, data: desired })
  }
  if (pending.length === 0) return false
  await before() // failure must abort, never overwrite without a backup
  for (const { file, target, signature, data } of pending) {
    await safePath(dirname(target), true)
    if ((await readBounded(target))?.signature !== signature) throw new Error('备份期间插件配置已变化，请重试')
    const temporary = join(dirname(target), `.webdav-config-${randomUUID()}.tmp`)
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    try {
      await handle.writeFile(Buffer.from(data, 'base64'))
      await handle.utimes(new Date(), new Date(file.modifiedAt))
      await handle.sync()
    } finally { await handle.close() }
    try {
      await safePath(dirname(target))
      if ((await readBounded(target))?.signature !== signature) throw new Error('写入前插件配置已变化，请重试')
      await rename(temporary, target)
    } finally { await unlink(temporary).catch(() => undefined) }
  }
  return true
}
