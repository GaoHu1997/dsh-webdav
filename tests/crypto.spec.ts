/**
 * The sealed envelope: the one thing that decides whether a profile can be
 * read off a server the user does not trust.
 *
 * `hashJson` is also the basis of every part hash the merge runs on, so its
 * key-order insensitivity is checked here rather than in the merge suite.
 */

import { describe, expect, it } from 'vitest'
import {
  CorruptError,
  FORMAT,
  ITERATIONS,
  NotBackupError,
  PassphraseError,
  hashJson,
  looksSealed,
  open,
  sameSecret,
  seal,
  stableJson,
  sum,
} from '../src/crypto.ts'

const SECRET = 'correct horse battery staple'

/** The envelope as the server sees it. */
async function envelope(value: unknown, passphrase = SECRET): Promise<Record<string, unknown>> {
  return JSON.parse(new TextDecoder().decode(await seal(value, passphrase))) as Record<string, unknown>
}

describe('seal and open', () => {
  it('round-trips a value', async () => {
    const value = { format: 'x', list: [1, 2, { deep: true }], text: '中文' }
    const sealed = await seal(value, SECRET)
    expect(await open(sealed, SECRET)).toEqual(value)
  })

  it('writes the envelope the format names', async () => {
    const body = await envelope({ a: 1 })
    expect(body['format']).toBe(FORMAT)
    expect(body['version']).toBe(1)
    expect(body['kdf']).toBe('pbkdf2-sha256')
    expect(body['iterations']).toBe(ITERATIONS)
    expect(typeof body['salt']).toBe('string')
    expect(typeof body['nonce']).toBe('string')
    expect(typeof body['data']).toBe('string')
  })

  it('is greppable at the head, so a cut-short write is recognisable', async () => {
    const sealed = await seal({ a: 1 }, SECRET)
    expect(looksSealed(sealed)).toBe(true)
    // The head survives a relay that truncated the body: that is the whole
    // point of the guard, and the tests below lean on it.
    expect(looksSealed(sealed.slice(0, 40))).toBe(true)
  })

  it('seals a different ciphertext every time, even for the same value', async () => {
    const one = await seal({ a: 1 }, SECRET)
    const two = await seal({ a: 1 }, SECRET)
    expect(sum(one)).not.toBe(sum(two))
  })

  it('needs a passphrase', async () => {
    await expect(seal({ a: 1 }, '')).rejects.toThrow(/口令/)
  })

  it('refuses the wrong passphrase', async () => {
    const sealed = await seal({ a: 1 }, SECRET)
    await expect(open(sealed, 'something else')).rejects.toBeInstanceOf(PassphraseError)
  })
})

describe('open rejects what it should', () => {
  it('calls an empty body "not a backup"', async () => {
    await expect(open(new Uint8Array(), SECRET)).rejects.toBeInstanceOf(NotBackupError)
  })

  it('calls a server HTML page "not a backup"', async () => {
    const page = new TextEncoder().encode('<!DOCTYPE html><title>Sign in</title>')
    await expect(open(page, SECRET)).rejects.toBeInstanceOf(NotBackupError)
  })

  it('calls another app\'s JSON "not a backup"', async () => {
    const other = new TextEncoder().encode('{"format":"magpie-backup","version":1}')
    await expect(open(other, SECRET)).rejects.toBeInstanceOf(NotBackupError)
  })

  it('calls a cut-short backup "damaged" rather than "another app\'s file"', async () => {
    const sealed = await seal({ a: 1 }, SECRET)
    // Keep the head, drop the tail: the head still names our format, so this
    // must be rebuildable rather than treated as a foreign file.
    const cut = sealed.slice(0, Math.floor(sealed.length / 2))
    expect(looksSealed(cut)).toBe(true)
    await expect(open(cut, SECRET)).rejects.toBeInstanceOf(CorruptError)
  })

  it('refuses a newer format version as another app\'s file', async () => {
    const body = await envelope({ a: 1 })
    body['version'] = 2
    const bytes = new TextEncoder().encode(JSON.stringify(body))
    await expect(open(bytes, SECRET)).rejects.toBeInstanceOf(NotBackupError)
  })

  it('refuses a different kdf without pretending it is damaged', async () => {
    const body = await envelope({ a: 1 })
    body['kdf'] = 'scrypt'
    const bytes = new TextEncoder().encode(JSON.stringify(body))
    await expect(open(bytes, SECRET)).rejects.toBeInstanceOf(NotBackupError)
  })

  it('rejects an absurd iteration count before spending the time on it', async () => {
    const body = await envelope({ a: 1 })
    body['iterations'] = 10
    const bytes = new TextEncoder().encode(JSON.stringify(body))
    await expect(open(bytes, SECRET)).rejects.toBeInstanceOf(CorruptError)
  })

  it('rejects a short salt and a wrong nonce length', async () => {
    const shortSalt = await envelope({ a: 1 })
    shortSalt['salt'] = 'ab'
    await expect(open(new TextEncoder().encode(JSON.stringify(shortSalt)), SECRET))
      .rejects.toBeInstanceOf(CorruptError)

    const shortNonce = await envelope({ a: 1 })
    shortNonce['nonce'] = 'ab'
    await expect(open(new TextEncoder().encode(JSON.stringify(shortNonce)), SECRET))
      .rejects.toBeInstanceOf(CorruptError)
  })

  it('rejects a body that carries no ciphertext at all', async () => {
    const body = await envelope({ a: 1 })
    body['data'] = ''
    await expect(open(new TextEncoder().encode(JSON.stringify(body)), SECRET))
      .rejects.toBeInstanceOf(CorruptError)
  })

  it('notices the envelope header is authenticated', async () => {
    // The header is the AAD, so changing the salt after sealing makes the tag
    // fail: that is a passphrase-strength failure, not a damaged file.
    const sealed = await seal({ a: 1 }, SECRET)
    const body = JSON.parse(new TextDecoder().decode(sealed)) as Record<string, unknown>
    const salt = String(body['salt'])
    body['salt'] = `${salt.slice(0, -2)}00`
    const bytes = new TextEncoder().encode(JSON.stringify(body))
    await expect(open(bytes, SECRET)).rejects.toBeInstanceOf(PassphraseError)
  })

  it('reads a body that starts with a byte-order mark', async () => {
    const sealed = await seal({ bom: true }, SECRET)
    const withBom = new Uint8Array(sealed.length + 3)
    withBom.set([0xef, 0xbb, 0xbf])
    withBom.set(sealed, 3)
    expect(await open(withBom, SECRET)).toEqual({ bom: true })
  })
})

describe('hashes', () => {
  it('hashes the same value the same way whatever the key order', () => {
    expect(hashJson({ a: 1, b: { c: 2, d: 3 } })).toBe(hashJson({ b: { d: 3, c: 2 }, a: 1 }))
  })

  it('hashes different values differently', () => {
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }))
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 1, b: 2 }))
  })

  it('sorts nested arrays of objects too', () => {
    expect(stableJson([{ y: 1, x: 2 }])).toBe(stableJson([{ x: 2, y: 1 }]))
    // Array order is data, not formatting: it must NOT be sorted away.
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]))
  })

  it('sums bytes and strings alike', () => {
    const bytes = new TextEncoder().encode('hello')
    expect(sum(bytes)).toBe(sum('hello'))
    expect(sum(bytes)).toHaveLength(64)
  })
})

describe('sameSecret', () => {
  it('compares equal secrets and unequal ones', () => {
    expect(sameSecret('hunter2', 'hunter2')).toBe(true)
    expect(sameSecret('hunter2', 'hunter3')).toBe(false)
    expect(sameSecret('hunter2', 'hunter22')).toBe(false)
    expect(sameSecret('', '')).toBe(true)
  })
})
