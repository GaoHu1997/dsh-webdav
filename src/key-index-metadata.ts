/**
 * Strict, IO-free merge of the model plugin's non-secret key-index metadata.
 * Absence is not a tombstone: refs and non-empty labels must not disappear in a
 * sync/restore. Other fields (including endpoints and balances) follow the winner.
 */

export interface KeyIndexMetadataEntry {
  ref: string
  alias?: string
  [field: string]: unknown
}

export interface KeyIndexMetadata {
  version: 1
  providers: Record<string, KeyIndexMetadataEntry[]>
  [field: string]: unknown
}

const MAX_BYTES = 1024 * 1024
// Kept identical to the host's KEY_ALIAS_MAX_LENGTH and normalizeKeyAlias rules.
const KEY_ALIAS_MAX_LENGTH = 40
const PROTOCOLS = new Set(['openai-completions', 'anthropic-messages', 'openai-responses'])
const SECRET_FIELD = /^(apiKey|accessToken|password|passphrase|secret|token|authorization)$/i

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function invalid(): never {
  // Never include the supplied document or a field value in errors.
  throw new Error('key-index 元数据无效或版本不受支持，已停止覆盖')
}

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Exact host normalizeKeyAlias semantics; used only to test visibility. */
function visibleAlias(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  let cleaned = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 32 || code === 127) continue
    cleaned += char
  }
  cleaned = cleaned.trim()
  if (cleaned.length === 0) return undefined
  return cleaned.slice(0, KEY_ALIAS_MAX_LENGTH)
}

function noSecrets(value: unknown, depth = 0, routeNames = false): void {
  if (depth > 64) invalid()
  if (value === null || typeof value !== 'object') return
  for (const [name, held] of Object.entries(value)) {
    // Only the immediate maps at the root use arbitrary route names, not fields.
    if (!routeNames && SECRET_FIELD.test(name) && typeof held === 'string' && held !== '') invalid()
    const childRoutes = depth === 0 && (name === 'providers' || name === 'endpoints' || name === 'balances')
    noSecrets(held, depth + 1, childRoutes)
  }
}

function stringMap(value: unknown, nested: boolean): boolean {
  if (!record(value)) return false
  return Object.entries(value).every(([route, held]) => nonblank(route)
    && (nested ? record(held) && Object.values(held).every(nonblank) : nonblank(held)))
}

/** Validate the complete shape; never turn malformed input into an empty index. */
export function validateKeyIndexMetadata(value: unknown): asserts value is KeyIndexMetadata {
  if (!record(value) || value['version'] !== 1 || !record(value['providers'])) invalid()
  noSecrets(value)
  for (const [route, entries] of Object.entries(value['providers'])) {
    if (!nonblank(route) || !Array.isArray(entries)) invalid()
    const seen = new Set<string>()
    for (const entry of entries) {
      if (!record(entry) || !nonblank(entry['ref']) || entry['ref'] !== entry['ref'].trim()) invalid()
      if (seen.has(entry['ref'])) invalid()
      seen.add(entry['ref'])
      if (entry['alias'] !== undefined && typeof entry['alias'] !== 'string') invalid()
      if (entry['models'] !== undefined && (!Array.isArray(entry['models']) || !entry['models'].every(nonblank))) invalid()
      if (entry['protocol'] !== undefined && (typeof entry['protocol'] !== 'string' || !PROTOCOLS.has(entry['protocol']))) invalid()
      if (entry['disabled'] !== undefined && typeof entry['disabled'] !== 'boolean') invalid()
      if (entry['auto'] !== undefined && typeof entry['auto'] !== 'boolean') invalid()
    }
  }
  if (value['endpoints'] !== undefined && !stringMap(value['endpoints'], true)) invalid()
  if (value['balances'] !== undefined && !stringMap(value['balances'], false)) invalid()
}

/**
 * Preferred rows lead the order and own all fields except a host-invisible alias.
 * Missing providers/refs are appended from the other copy. No deletion travels
 * until a future version introduces explicit tombstones and a migration.
 */
export function mergeKeyIndexMetadata(preferred: unknown, other?: unknown): KeyIndexMetadata {
  validateKeyIndexMetadata(preferred)
  if (other === undefined) return preferred
  validateKeyIndexMetadata(other)
  const routes = new Set([...Object.keys(preferred.providers), ...Object.keys(other.providers)])
  const providers = Object.fromEntries([...routes].map(route => {
    const preferredRows = Object.hasOwn(preferred.providers, route) ? preferred.providers[route] ?? [] : []
    const otherRows = Object.hasOwn(other.providers, route) ? other.providers[route] ?? [] : []
    const byRef = new Map(otherRows.map(entry => [entry.ref, entry]))
    const present = new Set(preferredRows.map(entry => entry.ref))
    const rows = preferredRows.map(entry => {
      const alternate = byRef.get(entry.ref)
      const alias = alternate?.alias
      if (visibleAlias(entry.alias) === undefined && alias !== undefined && visibleAlias(alias) !== undefined) {
        return { ...entry, alias }
      }
      return entry
    })
    rows.push(...otherRows.filter(entry => !present.has(entry.ref)))
    return [route, rows]
  }))
  return { ...preferred, providers }
}

function decode(data: string): KeyIndexMetadata {
  if (typeof data !== 'string' || data.length > Math.ceil(MAX_BYTES / 3) * 4) invalid()
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > MAX_BYTES || bytes.toString('base64') !== data) invalid()
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) invalid()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    invalid()
  }
  validateKeyIndexMetadata(value)
  return value
}

/** Base64 adapter used by the deployed 1.2.6 plugin-config module only. */
export function mergeKeyIndexData(preferredData: string, otherData?: string): string {
  const preferred = decode(preferredData)
  const merged = mergeKeyIndexMetadata(preferred, otherData === undefined ? undefined : decode(otherData))
  // Preserve exact winning bytes when the safety union adds nothing. This avoids
  // turning whitespace/mtime preservation into another configuration edit.
  if (JSON.stringify(merged.providers) === JSON.stringify(preferred.providers)) return preferredData
  const bytes = Buffer.from(JSON.stringify(merged), 'utf8')
  if (bytes.length > MAX_BYTES) invalid()
  return bytes.toString('base64')
}
