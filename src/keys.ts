/**
 * The `keys` part: the API keys this computer stores for the providers its
 * profile names, and putting back the ones a merge brings.
 *
 * A DSH profile never holds a key. It holds the *name* of one — `apiKeyEnv` on a
 * provider route, `secretEnv` on a webhook — and DSH resolves that name through
 * its credential service, which layers the launch environment over this
 * computer's own store (`$DSH_HOME/.credentials.yaml`). So a synced setup travels
 * complete and still cannot reach a single provider: the names arrive, and on the
 * other computer they resolve to nothing. That is the whole of this part.
 *
 * Two things follow from where the values live, and they are the two rules of
 * this module:
 *
 * - The names come from the synced configuration, not from the store. The
 *   credential service has no way to enumerate references — a configuration
 *   surface learns which ones exist from its own schema — so this plugin reads the
 *   names out of the very parts it is about to send, and asks the service for each
 *   one. That also keeps the two in step for free: a key travels exactly when the
 *   part that names it travels.
 * - Nothing here deletes. A key removed on one computer stays on the others, and a
 *   key that cannot be written is reported rather than skipped silently. See
 *   `docs/decisions/0054-sync-api-keys.md`.
 */

import { message } from './store.js'
import type { KeyProblem, KeysPart, Part } from './wire.js'

/**
 * The configuration field names DSH resolves as a credential reference.
 *
 * Taken from the schemas the shipped plugins declare: `apiKeyEnv` on the
 * `llm-pi-ai` provider routes, on `llm-deepseek-api-key` and on
 * `web-search-deepseek`; `secretEnv` on `webhook-github`. A plugin outside this
 * list names its credential some other way and its key does not travel — which is
 * why the list is here, in one place, rather than inline.
 */
export const CREDENTIAL_FIELDS: readonly string[] = ['apiKeyEnv', 'secretEnv']

/** One reference's value as the credential service resolved it. */
export interface ResolvedKey {
  /** The non-empty secret. */
  value: string
  /**
   * Which layer supplied it: `env`, `file`, `project-env` or `user-env`.
   *
   * Only `file` — the provider-managed store, the one layer `set` writes to —
   * travels. See {@link readKeys}.
   */
  source: string
}

/**
 * DSH's credential service, as far as this plugin uses it.
 *
 * Structural on purpose: the service belongs to another package, and this plugin
 * neither depends on it nor requires it to be there. The two methods are `resolve`
 * and `set` on `CredentialProvider`; `store` is the name this module gives the
 * write, so a reader of the engine never has to know which word DSH picked.
 */
export interface CredentialService {
  resolve(ref: string): Promise<ResolvedKey | undefined>
  set(ref: string, value: string): Promise<void>
}

/** The two operations the sync needs: what is behind a name, and how to store one. */
export interface KeysPort {
  resolve(ref: string): Promise<ResolvedKey | undefined>
  store(ref: string, value: string): Promise<void>
}

/** What one read of this computer's keys produced. */
export interface KeysRead {
  /** What travels, absent when this computer has no value for any name it knows. */
  part?: KeysPart
  /** References that could not be read, with the reason. */
  problems: KeyProblem[]
}

/**
 * The credential service in the shape this plugin uses it.
 *
 * `set` rejects while a read-only layer shadows the reference, which is exactly
 * the fact that matters here: a value that would not take effect is not one to
 * report as stored. {@link applyKeys} therefore asks first and writes second.
 */
export function keysPort(service: CredentialService): KeysPort {
  return {
    resolve: (ref) => service.resolve(ref),
    store: (ref, value) => service.set(ref, value),
  }
}

/**
 * Every credential-reference name the given parts name, deduplicated and sorted.
 *
 * Walks the parts as they are — no schema, no interpretation — because the value
 * of a reference field is a name wherever it sits, and the shape of a provider
 * config is the provider plugin's to decide, not this one's.
 */
export function credentialRefs(parts: Partial<Record<Part, unknown>>): string[] {
  const found = new Set<string>()
  for (const part of Object.values(parts)) walk(part, found)
  return [...found].sort()
}

function walk(value: unknown, into: Set<string>): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) walk(item, into)
    return
  }
  for (const [key, held] of Object.entries(value)) {
    if (CREDENTIAL_FIELDS.includes(key)) {
      const ref = typeof held === 'string' ? held.trim() : ''
      if (ref !== '') into.add(ref)
      continue
    }
    walk(held, into)
  }
}

/**
 * Read the keys this computer holds for the names in hand.
 *
 * Only the managed store travels: a name the launching environment supplies is
 * left out, and so is one that falls through to a `.env`. Two reasons, and they
 * agree — the store is the one layer this plugin can write back to, and an
 * environment export belongs to whoever started DSH, not to this computer's
 * stored setup. The environment-wins rule is the service's own
 * (`resolve().source` is `'env'` whenever the inherited environment has the name,
 * and a write is refused while it does), so a name that is both exported and
 * stored is read as an export and left here; unsetting it in the shell is what
 * makes the stored value the one in force, and the one that travels.
 *
 * A name with no stored value is skipped, not reported: plenty of profiles name a
 * provider nobody has signed in to, and "this key is not here either" is not a
 * failure of the sync. A name that cannot be resolved *at all* is different, and
 * is reported — a store that cannot be read must not look like a store with
 * nothing in it, or a sync would read it as "this computer has no keys".
 */
export async function readKeys(
  port: KeysPort | undefined,
  parts: Partial<Record<Part, unknown>>,
): Promise<KeysRead> {
  const refs = credentialRefs(parts)
  if (refs.length === 0) return { problems: [] }
  if (port === undefined) return { problems: [{ ref: '', message: NO_SERVICE }] }
  const found: Record<string, string> = {}
  const problems: KeyProblem[] = []
  for (const ref of refs) {
    try {
      const resolved = await port.resolve(ref)
      if (resolved !== undefined && resolved.source === 'file' && resolved.value !== '') found[ref] = resolved.value
    } catch (cause) {
      problems.push({ ref, message: message(cause) })
    }
  }
  if (Object.keys(found).length === 0) return { problems }
  return { part: { refs: found }, problems }
}

/**
 * The two copies of the `keys` part, combined.
 *
 * Keys are a set of named secrets rather than one document, and two computers
 * usually change them for different providers — each store holds the key its own
 * Models page was just handed. Picking either copy as "the" answer therefore
 * takes the other computer's keys away. A reference both sides hold keeps the
 * value from `local`: it is the one that authenticates the requests made here,
 * and it may have been stored a moment ago through a surface that touches no
 * file this plugin can watch. A reference only the server has is added.
 *
 * Nothing is removed: a name that one side dropped stays in the union, the same
 * rule {@link applyKeys} follows when it writes.
 */
export function unionKeys(local: KeysPart | undefined, remote: unknown): KeysPart {
  const refs: Record<string, string> = {}
  for (const part of [remote, local]) {
    if (part === null || typeof part !== 'object') continue
    const held = (part as { refs?: unknown }).refs
    if (held === null || typeof held !== 'object') continue
    for (const [ref, value] of Object.entries(held as Record<string, unknown>)) {
      if (ref === '' || typeof value !== 'string' || value === '') continue
      refs[ref] = value
    }
  }
  return { refs }
}

/** What one {@link applyKeys} call did, for the card's line about the run. */
export interface KeysWrite {
  /** References this call actually stored; a same-value one is not a write. */
  written: string[]
  /** References that could not be written, with the reason. */
  problems: KeyProblem[]
}

/**
 * Put the merged keys part into this computer's store, and report what would not
 * go in.
 *
 * A value already in force here is left alone. That is not an optimisation: the
 * service refuses a write while a read-only layer shadows the reference, and a
 * value that is already the one in force — the same key, exported and stored —
 * would be reported as a failure for saying so twice.
 *
 * `beforeWrite` is called at most once, just before the first value that really
 * replaces something. A credential has no copy kept by the caller any other way,
 * so it is the callback's job to seal one: overwriting a key without keeping the
 * value it had would leave undo with nothing to put back.
 *
 * `null` — the merge's way of saying the part was taken away — writes nothing. No
 * credential is ever removed by a sync.
 */
export async function applyKeys(
  port: KeysPort | undefined,
  part: KeysPart | null | undefined,
  beforeWrite: () => Promise<void> = async () => undefined,
): Promise<KeysWrite> {
  if (part === null || part === undefined) return { written: [], problems: [] }
  const entries = Object.entries(part.refs ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  if (entries.length === 0) return { written: [], problems: [] }
  if (port === undefined) return { written: [], problems: [{ ref: '', message: NO_SERVICE }] }
  const written: string[] = []
  const problems: KeyProblem[] = []
  let kept = false
  for (const [ref, value] of entries) {
    if (typeof value !== 'string' || value === '') continue
    try {
      const current = await port.resolve(ref)
      if (current !== undefined && current.value === value) continue
      if (!kept) {
        kept = true
        await beforeWrite()
      }
      await port.store(ref, value)
      written.push(ref)
    } catch (cause) {
      problems.push({ ref, message: message(cause) })
    }
  }
  return { written, problems }
}

/** Said whenever the host has no credential service to read or write at all. */
const NO_SERVICE = '这台电脑没有 DSH 的凭据服务，API 密钥不在这里读写'
