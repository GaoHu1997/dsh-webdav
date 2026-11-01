import { describe, expect, it } from 'vitest'
import {
  mergeKeyIndexData,
  mergeKeyIndexMetadata,
  validateKeyIndexMetadata,
  type KeyIndexMetadata,
} from '../src/key-index-metadata.ts'

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64')
const decode = (value: string): KeyIndexMetadata => JSON.parse(Buffer.from(value, 'base64').toString('utf8'))
const index = (providers: KeyIndexMetadata['providers'] = {}): KeyIndexMetadata => ({ version: 1, providers })

const full = (): KeyIndexMetadata => ({
  version: 1,
  providers: {
    route: [{ ref: 'META_A', alias: '主入口', models: ['model-a'] }, { ref: 'META_B', alias: '备用' }],
    extra: [{ ref: 'META_C', alias: '独立路由' }],
  },
  endpoints: { route: { openai: 'https://local.invalid/v1' } },
  balances: { route: 'https://local.invalid/balance' },
})

const malformed: [string, unknown][] = [
  ['null root', null],
  ['array root', []],
  ['missing version', { providers: {} }],
  ['future version', { version: 2, providers: {} }],
  ['missing providers', { version: 1 }],
  ['null providers', { version: 1, providers: null }],
  ['array providers', { version: 1, providers: [] }],
  ['non-array route', { version: 1, providers: { route: {} } }],
  ['null entry', { version: 1, providers: { route: [null] } }],
  ['missing ref', { version: 1, providers: { route: [{ alias: '标签' }] } }],
  ['blank ref', { version: 1, providers: { route: [{ ref: ' ' }] } }],
  ['padded ref', { version: 1, providers: { route: [{ ref: ' META_A ' }] } }],
  ['duplicate ref', { version: 1, providers: { route: [{ ref: 'META_A' }, { ref: 'META_A' }] } }],
  ['wrong alias type', { version: 1, providers: { route: [{ ref: 'META_A', alias: false }] } }],
  ['wrong models type', { version: 1, providers: { route: [{ ref: 'META_A', models: {} }] } }],
  ['unknown protocol', { version: 1, providers: { route: [{ ref: 'META_A', protocol: 'future-api' }] } }],
  ['wrong disabled type', { version: 1, providers: { route: [{ ref: 'META_A', disabled: 'yes' }] } }],
  ['wrong auto type', { version: 1, providers: { route: [{ ref: 'META_A', auto: 1 }] } }],
  ['bad endpoint map', { version: 1, providers: {}, endpoints: { route: [] } }],
  ['bad balance map', { version: 1, providers: {}, balances: { route: false } }],
]

describe('strict key-index metadata safety union', () => {
  it('adds missing routes and refs but retains only the preferred endpoints/balances', () => {
    const preferred = {
      ...index(),
      endpoints: { route: { anthropic: 'https://winner.invalid/api' } },
      balances: { route: 'https://winner.invalid/balance' },
    }
    const merged = mergeKeyIndexMetadata(preferred, full())
    expect(merged.providers).toEqual(full().providers)
    expect(merged.endpoints).toEqual(preferred.endpoints)
    expect(merged.balances).toEqual(preferred.balances)
  })

  it('retains more refs even when the preferred copy contains fewer', () => {
    const preferred = index({ route: [{ ref: 'META_A', alias: '新标签', disabled: true }] })
    const merged = mergeKeyIndexMetadata(preferred, full())
    expect(merged.providers.route).toEqual([
      { ref: 'META_A', alias: '新标签', disabled: true },
      { ref: 'META_B', alias: '备用' },
    ])
    expect(merged.providers.extra).toEqual(full().providers.extra)
    expect(merged.endpoints).toBeUndefined()
    expect(merged.balances).toBeUndefined()
  })

  it.each([undefined, '', '   ', '\u0000', '\u007f', '\u0000\u0001\u007f \t'])('keeps a host-visible alias when preferred alias is %j', alias => {
    const entry = alias === undefined ? { ref: 'META_A' } : { ref: 'META_A', alias }
    expect(mergeKeyIndexMetadata(index({ route: [entry] }), full()).providers.route?.[0]).toEqual({
      ref: 'META_A', alias: '主入口',
    })
  })

  it.each(['\u0000 usable\u007f ', '  ' + 'x'.repeat(60) + '\t', '  ' + '🙂'.repeat(30) + '\u0000'])('preserves exact winning bytes for a host-visible alias %j', alias => {
    const preferred = index({ route: [{ ref: 'META_A', alias, disabled: true, models: [] }] })
    const other = index({ route: [{ ref: 'META_A', alias: 'fallback', disabled: false }] })
    const bytes = Buffer.from(JSON.stringify(preferred, null, 2)).toString('base64')
    expect(mergeKeyIndexMetadata(preferred, other)).toEqual(preferred)
    expect(mergeKeyIndexData(bytes, encode(other))).toBe(bytes)
  })

  it('keeps raw fallback bytes and remains idempotent after restoring a visible label', () => {
    const preferred = index({ route: [{ ref: 'META_A', alias: '\u0000\u007f', disabled: true }] })
    const other = index({ route: [{ ref: 'META_A', alias: ' \u0000备用\t ' }] })
    const once = mergeKeyIndexData(encode(preferred), encode(other))
    expect(decode(once).providers.route?.[0]).toEqual({ ref: 'META_A', alias: ' \u0000备用\t ', disabled: true })
    expect(mergeKeyIndexData(once, encode(other))).toBe(once)
  })

  it('does not invent a label when both raw aliases are invisible to the host', () => {
    const preferred = index({ route: [{ ref: 'META_A', alias: '\u0000' }] })
    const other = index({ route: [{ ref: 'META_A', alias: '\u007f' }] })
    expect(mergeKeyIndexMetadata(preferred, other)).toEqual(preferred)
    expect(mergeKeyIndexData(encode(preferred), encode(other))).toBe(encode(preferred))
  })

  it('uses preferred same-ref fields rather than reviving removed scopes or flags', () => {
    const old = index({ route: [{ ref: 'META_A', alias: '标签', models: ['old'], disabled: true, auto: true }] })
    expect(mergeKeyIndexMetadata(index({ route: [{ ref: 'META_A' }] }), old).providers.route).toEqual([
      { ref: 'META_A', alias: '标签' },
    ])
    const preferred = index({ route: [{ ref: 'META_A', models: [], disabled: false, auto: false, protocol: 'openai-responses' }] })
    expect(mergeKeyIndexMetadata(preferred, old).providers.route?.[0]).toEqual({ ...preferred.providers.route?.[0], alias: '标签' })
  })

  it('preserves winning route/ref order and does not mutate either input', () => {
    const other = full()
    const preferred = index({ route: [{ ref: 'META_B', alias: 'winner' }, { ref: 'META_D' }] })
    const before = JSON.stringify([preferred, other])
    expect(mergeKeyIndexMetadata(preferred, other).providers.route?.map(entry => entry.ref)).toEqual(['META_B', 'META_D', 'META_A'])
    expect(JSON.stringify([preferred, other])).toBe(before)
  })

  it('is idempotent and retains exact preferred bytes when nothing needs adding', () => {
    const text = Buffer.from(JSON.stringify(full(), null, 2)).toString('base64')
    expect(mergeKeyIndexData(text, encode(index()))).toBe(text)
    const once = mergeKeyIndexData(encode(index()), text)
    expect(mergeKeyIndexData(once, text)).toBe(once)
    expect(decode(once).providers).toEqual(full().providers)
  })

  it('handles own-only route names without prototype lookup', () => {
    const other = index(Object.fromEntries(['constructor', '__proto__', 'toString'].map(route => [route, [{ ref: `META_${route}` }]])))
    const merged = mergeKeyIndexMetadata(index(), other)
    expect(merged.providers).toEqual(other.providers)
    expect(Object.hasOwn(merged.providers, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(merged.providers)).toBe(Object.prototype)
  })

  it('keeps an empty version-1 index valid without inventing refs', () => {
    expect(mergeKeyIndexMetadata(index(), index())).toEqual(index())
    expect(mergeKeyIndexData(encode(index()))).toBe(encode(index()))
  })

  it.each(malformed)('rejects %s instead of laundering it into an empty index', (_name, raw) => {
    expect(() => validateKeyIndexMetadata(raw)).toThrow('key-index 元数据无效')
    expect(() => mergeKeyIndexMetadata(raw, full())).toThrow()
    expect(() => mergeKeyIndexMetadata(full(), raw)).toThrow()
    expect(() => mergeKeyIndexData(encode(raw))).toThrow()
    expect(() => mergeKeyIndexData(encode(full()), encode(raw))).toThrow()
  })

  it('rejects noncanonical base64, bad JSON and invalid UTF-8 without including input in errors', () => {
    expect(() => mergeKeyIndexData(encode(index()) + '\n')).toThrow()
    expect(() => mergeKeyIndexData(Buffer.from('{broken').toString('base64'))).toThrow('key-index 元数据无效')
    const bytes = Buffer.from(JSON.stringify(index({ route: [{ ref: 'META_A', alias: 'x' }] })))
    bytes[bytes.indexOf(Buffer.from('"x"')) + 1] = 0xff
    expect(() => mergeKeyIndexData(bytes.toString('base64'))).toThrow('key-index 元数据无效')
  })

  it('rejects inline secret fields and cyclic decoded input', () => {
    expect(() => mergeKeyIndexMetadata({ version: 1, providers: {}, token: 'fixture' })).toThrow('key-index 元数据无效')
    const cyclic: Record<string, unknown> = { version: 1, providers: {} }
    cyclic.loop = cyclic
    expect(() => mergeKeyIndexMetadata(cyclic)).toThrow('key-index 元数据无效')
  })

  it('allows secret-looking route names only in the three root route maps', () => {
    const routes = ['token', 'password', 'apiKey', 'accessToken', 'passphrase', 'secret', 'authorization']
    const value = {
      ...index(Object.fromEntries(routes.map(route => [route, [{ ref: `META_${route.toUpperCase()}`, alias: `${route} route`, models: [], disabled: true }]]))),
      endpoints: Object.fromEntries(routes.map(route => [route, { openai: 'https://route.invalid/v1', anthropic: 'https://route.invalid/api' }])),
      balances: Object.fromEntries(routes.map(route => [route, 'https://route.invalid/balance'])),
    }
    expect(() => validateKeyIndexMetadata(value)).not.toThrow()
    expect(mergeKeyIndexMetadata(value, index())).toEqual(value)
    expect(mergeKeyIndexData(encode(value), encode(index()))).toBe(encode(value))
  })

  it.each(['apiKey', 'accessToken', 'password', 'passphrase', 'secret', 'token', 'authorization'])('still rejects actual %s fields outside route-name positions', field => {
    const cases: unknown[] = [
      { ...index(), [field]: 'fixture' },
      index({ route: [{ ref: 'META_A', [field]: 'fixture' }] }),
      index({ route: [{ ref: 'META_A', metadata: { [field]: 'fixture' } }] }),
      index({ route: [{ ref: 'META_A', balances: { [field]: 'fixture' } }] }),
      { ...index(), extension: { balances: { [field]: 'fixture' } } },
      { ...index(), endpoints: { route: { openai: 'https://route.invalid/v1', [field]: 'fixture' } } },
      { version: 1, providers: { [field]: 'fixture' } },
    ]
    for (const value of cases) {
      expect(() => validateKeyIndexMetadata(value)).toThrow('key-index 元数据无效')
      expect(() => mergeKeyIndexData(encode(value))).toThrow('key-index 元数据无效')
    }
  })

  it('rejects an oversized union instead of dropping rows to fit', () => {
    const large = (ref: string) => index({ route: [{ ref, alias: 'x'.repeat(600_000) }] })
    expect(() => mergeKeyIndexData(encode(large('META_A')), encode(large('META_B')))).toThrow('key-index 元数据无效')
    expect(() => mergeKeyIndexData(encode(index({ route: [{ ref: 'META_A', alias: 'x'.repeat(1024 * 1024) }] })))).toThrow()
  })
})
