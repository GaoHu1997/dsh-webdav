/**
 * The sealed envelope the backup travels in: AES-256-GCM under a key derived
 * from the passphrase with PBKDF2-SHA256. Nothing in it can be read without the
 * passphrase — not by the WebDAV server, not by whoever else reaches the file.
 *
 * The envelope's own fields are authenticated as additional data, so the KDF
 * parameters or salt cannot be swapped for weaker ones unnoticed.
 */

import { createCipheriv, createDecipheriv, pbkdf2, randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const pbkdf2Async = promisify(pbkdf2)

/** Envelope format word. A file that does not carry it is not ours. */
export const FORMAT = 'dsh-webdav-sync-backup'

/** PBKDF2 rounds. Matches the cost magpie settled on for the same job. */
export const ITERATIONS = 600_000

/** Rounds accepted when opening: a floor against a file that asks for a cheap KDF. */
const MIN_ITERATIONS = 100_000
const MAX_ITERATIONS = 10_000_000

const SALT_BYTES = 16
const NONCE_BYTES = 12
const KEY_BYTES = 32

/** The wire envelope. Every field is authenticated by {@link header}. */
export interface Envelope {
  format: string
  version: number
  kdf: string
  iterations: number
  salt: string
  nonce: string
  data: string
}

/** The passphrase does not open this file — wrong passphrase, or the file changed. */
export class PassphraseError extends Error {
  constructor() {
    super('口令打不开服务器上的文件：请用你在其他机器上设置的那个口令')
    this.name = 'PassphraseError'
  }
}

/** The bytes are not a backup of ours, or are one cut short. */
export class CorruptError extends Error {
  constructor(message = '服务器上的文件不是一份完整的 dsh-webdav-sync 备份') {
    super(message)
    this.name = 'CorruptError'
  }
}

/** The file is a backup, but of a format this build does not read. */
export class NotBackupError extends Error {
  constructor() {
    super('服务器上的文件不是 dsh-webdav-sync 写出来的')
    this.name = 'NotBackupError'
  }
}

/** `true` when the body begins like a sealed backup, whatever it does after that. */
export function looksSealed(data: Uint8Array): boolean {
  const text = new TextDecoder().decode(data.subarray(0, 256)).replace(/\s+/g, '')
  return text.startsWith('{"format":"' + FORMAT + '"')
}

/**
 * Seal a value into the envelope. The returned bytes are what leaves the
 * computer; nothing else of the setup ever does.
 */
export async function seal(value: unknown, passphrase: string): Promise<Uint8Array> {
  // An empty passphrase would seal the profile with a key anyone can derive,
  // which is worse than not syncing at all: refuse rather than pretend.
  if (passphrase.trim() === '') throw new Error('备份需要一个口令来加密')
  const salt = randomBytes(SALT_BYTES)
  const nonce = randomBytes(NONCE_BYTES)
  const envelope: Envelope = {
    format: FORMAT,
    version: 1,
    kdf: 'pbkdf2-sha256',
    iterations: ITERATIONS,
    salt: salt.toString('hex'),
    nonce: nonce.toString('hex'),
    data: '',
  }
  const key = await derive(passphrase, salt, envelope.iterations)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(header(envelope))
  const plain = Buffer.from(JSON.stringify(value), 'utf8')
  const sealed = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  envelope.data = Buffer.concat([sealed, tag]).toString('base64')
  // Indented so the head of the file reads as a backup at a glance, and a
  // relay that cuts the body short still leaves a recognizable head behind.
  return Buffer.from(JSON.stringify(envelope, null, 2), 'utf8')
}

/**
 * Open a sealed envelope. Throws {@link PassphraseError} when the passphrase is
 * wrong and {@link CorruptError} / {@link NotBackupError} when the bytes are not
 * a readable backup of ours.
 */
export async function open(data: Uint8Array, passphrase: string): Promise<unknown> {
  const text = new TextDecoder().decode(stripBom(data))
  let envelope: Envelope
  try {
    envelope = JSON.parse(text) as Envelope
  } catch {
    // A backup a relay cut short ends in the middle of `data` and fails here, as
    // does a sign-in page a captive portal answered with. Only a body that
    // begins like ours counts as damage.
    if (looksSealed(data)) throw new CorruptError()
    throw new NotBackupError()
  }
  if (envelope.format !== FORMAT) throw new NotBackupError()
  if (envelope.version !== 1 || envelope.kdf !== 'pbkdf2-sha256') {
    throw new NotBackupError()
  }
  const salt = Buffer.from(envelope.salt ?? '', 'hex')
  const nonce = Buffer.from(envelope.nonce ?? '', 'hex')
  if (
    !Number.isInteger(envelope.iterations) ||
    envelope.iterations < MIN_ITERATIONS ||
    envelope.iterations > MAX_ITERATIONS ||
    nonce.length !== NONCE_BYTES ||
    salt.length < SALT_BYTES
  ) {
    throw new CorruptError()
  }
  const body = Buffer.from(envelope.data ?? '', 'base64')
  if (body.length <= 16) throw new CorruptError()
  const key = await derive(passphrase, salt, envelope.iterations)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(header(envelope))
  decipher.setAuthTag(body.subarray(body.length - 16))
  let plain: Buffer
  try {
    plain = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()])
  } catch {
    // A tag that does not verify means the passphrase is wrong or the file was
    // changed after it was written; the two are indistinguishable on purpose.
    throw new PassphraseError()
  }
  try {
    return JSON.parse(plain.toString('utf8'))
  } catch {
    throw new CorruptError('服务器上的文件解开了，但里面不是可读的 dsh 配置')
  }
}

/** What the sealing authenticates besides the bundle: the envelope's own fields. */
function header(envelope: Envelope): Buffer {
  return Buffer.from(
    `${envelope.format}/${envelope.version}/${envelope.kdf}/${envelope.iterations}/${envelope.salt}`,
    'utf8',
  )
}

async function derive(passphrase: string, salt: Buffer, iterations: number): Promise<Buffer> {
  return (await pbkdf2Async(passphrase, salt, iterations, KEY_BYTES, 'sha256')) as Buffer
}

/** Lowercase hex SHA-256, the plugin's one hash. */
export function sum(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Lowercase hex SHA-256 of a value's canonical JSON, for whole-object hashing. */
export function hashJson(value: unknown): string {
  return sum(stableJson(value))
}

/**
 * JSON with object keys sorted, so the same value hashes the same however the
 * YAML it came from happened to order its keys.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) out[key] = sortValue(record[key])
  return out
}

/** Constant-time string comparison, for anything secret-shaped. */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * The bytes without a byte-order mark. An editor on Windows may leave one at the
 * head of a file it wrote, and a JSON parse fails on it for a reason that says
 * nothing about what is actually wrong.
 */
export function stripBom(data: Uint8Array): Uint8Array {
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return data.subarray(3)
  return data
}
