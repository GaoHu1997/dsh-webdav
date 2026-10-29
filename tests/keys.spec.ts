/**
 * The `keys` part: the API keys a profile names but does not hold.
 *
 * Two things are being pinned down here. The first is which names travel: a
 * credential is named by the configuration (`apiKeyEnv`, `secretEnv`) and the
 * value lives in this computer's store, so the walk over the parts is the only
 * thing that decides what the sync even asks for. The second is what a failure
 * looks like: a store that cannot be read must never come back as a store with
 * nothing in it, or the next sync would treat every key here as deleted.
 *
 * The engine tests at the bottom run the whole thing through a real profile and a
 * fake WebDAV server, because the interesting question is not what this module
 * returns but whether the key actually arrives on the other computer.
 */

import { readFile, readdir } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { BUNDLE_APP, BUNDLE_FORMAT, BUNDLE_VERSION, type Bundle, type SyncConfig } from '../src/wire.ts'
import { open, seal } from '../src/crypto.ts'
import { engineFor, preview, status, sync } from '../src/engine.ts'
import { CREDENTIAL_FIELDS, applyKeys, credentialRefs, keysPort, readKeys, unionKeys, type KeysPort } from '../src/keys.ts'
import { keptDir } from '../src/state.ts'
import { FakeDav } from './fake-dav.ts'
import { cleanUp, configFor, writeProfile } from './harness.ts'

const FILE_PATH = '/dav/dsh-webdav/dsh-profile.prop'
const PASSPHRASE = 'a passphrase'

let stop: (() => void) | undefined

afterEach(async () => {
  stop?.()
  stop = undefined
  await cleanUp()
})

/** A credential store held in memory, with what happened to it recorded. */
function store(values: Record<string, string> = {}, options: { source?: string; refuse?: string[] } = {}): KeysPort & {
  readonly written: { ref: string; value: string }[]
} {
  const written: { ref: string; value: string }[] = []
  return {
    written,
    resolve: async (ref) => {
      const value = values[ref]
      return value === undefined ? undefined : { value, source: options.source ?? 'file' }
    },
    store: async (ref, value) => {
      if ((options.refuse ?? []).includes(ref)) throw new Error(`read-only source shadows ${ref}`)
      written.push({ ref, value })
      values[ref] = value
    },
  }
}

/** A store whose every read fails, the way a corrupt file on disk would. */
function broken(reason = 'the credential file is not readable'): KeysPort {
  return {
    resolve: async () => {
      throw new Error(reason)
    },
    store: async () => {
      throw new Error(reason)
    },
  }
}

/** A profile naming two providers and a webhook, so more than one field is walked. */
const TWO_PROVIDERS = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      wb:
        displayName: 歪比巴布
        apiKeyEnv: WB_API_KEY
      ofox:
        displayName: OFOX
        apiKeyEnv: OFOX_API_KEY

- id: webhook-github
  name: "@deepseek-ai/dsh-webhook-github"
  config:
    secretEnv: GITHUB_HOOK_SECRET
`

function serve(options = {}): FakeDav {
  const dav = new FakeDav(options)
  dav.seedCollection('/dav/dsh-webdav')
  stop = dav.use()
  return dav
}

function config(over: Partial<SyncConfig> = {}): SyncConfig {
  return configFor({ passphrase: PASSPHRASE, ...over })
}

/** The bundle the server holds now, opened. */
async function readRemote(dav: FakeDav): Promise<Bundle> {
  const bytes = dav.files.get(FILE_PATH)?.data
  expect(bytes).toBeDefined()
  return (await open(bytes as Uint8Array, PASSPHRASE)) as Bundle
}

/** Seal a bundle and put it on the server, as another computer would have. */
async function seedRemote(dav: FakeDav, parts: Partial<Bundle>, created?: string): Promise<void> {
  const bundle: Bundle = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    created: created ?? new Date().toISOString(),
    app: BUNDLE_APP,
    ...parts,
  }
  dav.seed(FILE_PATH, await seal(bundle, PASSPHRASE))
}

describe('the names a profile asks for', () => {
  it('walks every part for the two fields DSH resolves as a credential', () => {
    const refs = credentialRefs({
      models: { config: { providers: { wb: { apiKeyEnv: 'WB_API_KEY' } } } },
      patch: [{ id: 'webhook-github', config: { secretEnv: 'GITHUB_HOOK_SECRET' } }],
    })
    expect(refs).toEqual(['GITHUB_HOOK_SECRET', 'WB_API_KEY'])
  })

  it('sorts and deduplicates, so one key is asked for once however many places name it', () => {
    const refs = credentialRefs({
      models: { config: { providers: { a: { apiKeyEnv: 'ONE' }, b: { apiKeyEnv: 'ONE' }, c: { apiKeyEnv: 'TWO' } } } },
    })
    expect(refs).toEqual(['ONE', 'TWO'])
  })

  it('ignores a blank or non-string name, which is a provider nobody configured', () => {
    const refs = credentialRefs({
      models: { config: { providers: { a: { apiKeyEnv: '   ' }, b: { apiKeyEnv: 7 }, c: { apiKeyEnv: null } } } },
    })
    expect(refs).toEqual([])
  })

  it('reads the field wherever it sits, and only the fields on the list', () => {
    // The shape of a provider config belongs to the provider plugin, so the walk
    // does not assume one; and a field that merely *looks* like a reference is
    // not one, or a profile could make this plugin read an arbitrary secret.
    const refs = credentialRefs({
      patch: [
        { config: { deep: { deeper: [{ apiKeyEnv: 'NESTED' }] } } },
        { config: { apiKey: 'not-a-reference', tokenEnv: 'ALSO_NOT' } },
      ],
    })
    expect(refs).toEqual(['NESTED'])
    expect(CREDENTIAL_FIELDS).toEqual(['apiKeyEnv', 'secretEnv'])
  })
})

describe('reading this computer’s keys', () => {
  it('says nothing at all when the profile names no credential', async () => {
    // Not "an empty part": a part that travels as `{ refs: {} }` would tell the
    // other computer that this one has no keys, which is a claim, not silence.
    const read = await readKeys(store(), { patch: [{ id: 'permission' }] })
    expect(read.part).toBeUndefined()
    expect(read.problems).toEqual([])
  })

  it('carries the values of the names the profile uses, and only those', async () => {
    const port = store({ WB_API_KEY: 'wb-secret', UNUSED_KEY: 'nobody-names-this' })
    const read = await readKeys(port, { models: { config: { providers: { wb: { apiKeyEnv: 'WB_API_KEY' } } } } })
    expect(read.part).toEqual({ refs: { WB_API_KEY: 'wb-secret' } })
    expect(read.problems).toEqual([])
  })

  it('leaves a name the environment supplies behind, since that is not this computer’s setup', async () => {
    const read = await readKeys(
      store({ WB_API_KEY: 'from-shell' }, { source: 'env' }),
      { models: { config: { providers: { wb: { apiKeyEnv: 'WB_API_KEY' } } } } },
    )
    expect(read.part).toBeUndefined()
    expect(read.problems).toEqual([])
  })

  it('skips a name with no stored value instead of calling it a failure', async () => {
    // A profile names providers nobody has signed in to. That is not an error and
    // must not be drawn as one; the part simply has nothing to say about it.
    const read = await readKeys(store({ OTHER: 'x' }), { models: { config: { providers: { wb: { apiKeyEnv: 'WB_API_KEY' } } } } })
    expect(read.part).toBeUndefined()
    expect(read.problems).toEqual([])
  })

  it('reports the name it could not resolve, and still carries the ones it could', async () => {
    const port: KeysPort = {
      resolve: async (ref) => {
        if (ref === 'WB_API_KEY') throw new Error('decryption failed')
        return { value: 'ofox-secret', source: 'file' }
      },
      store: async () => undefined,
    }
    const read = await readKeys(port, {
      models: { config: { providers: { wb: { apiKeyEnv: 'WB_API_KEY' }, ofox: { apiKeyEnv: 'OFOX_API_KEY' } } } },
    })
    expect(read.part).toEqual({ refs: { OFOX_API_KEY: 'ofox-secret' } })
    expect(read.problems.map((problem) => problem.ref)).toEqual(['WB_API_KEY'])
    expect(read.problems[0]?.message).toContain('decryption failed')
  })

  it('says the store is missing rather than that this computer has no keys', async () => {
    // The distinction the whole `problems` list exists for: a host without the
    // service cannot know, and an empty part would be a claim it cannot make.
    const read = await readKeys(undefined, { models: { config: { providers: { wb: { apiKeyEnv: 'WB_API_KEY' } } } } })
    expect(read.part).toBeUndefined()
    expect(read.problems).toHaveLength(1)
    expect(read.problems[0]?.ref).toBe('')
  })
})

describe('putting keys back', () => {
  it('writes every value the merge brought, and reports nothing', async () => {
    const port = store()
    const result = await applyKeys(port, { refs: { WB_API_KEY: 'wb', OFOX_API_KEY: 'ofox' } })
    expect(result.problems).toEqual([])
    // Names, in the order they went in: what the card says arrived here.
    expect(result.written).toEqual(['OFOX_API_KEY', 'WB_API_KEY'])
    expect(port.written).toEqual([
      { ref: 'OFOX_API_KEY', value: 'ofox' },
      { ref: 'WB_API_KEY', value: 'wb' },
    ])
  })

  it('leaves a value that is already in force alone', async () => {
    // Not an optimisation: the service refuses a write while a read-only layer
    // shadows the reference, so re-writing the value in force would report a
    // failure for saying the same thing twice.
    const port = store({ WB_API_KEY: 'wb' })
    const result = await applyKeys(port, { refs: { WB_API_KEY: 'wb' } })
    expect(result.problems).toEqual([])
    expect(result.written).toEqual([])
    expect(port.written).toEqual([])
  })

  it('keeps one copy aside, and only when something is really replaced', async () => {
    let kept = 0
    const port = store({ WB_API_KEY: 'wb' })
    await applyKeys(port, { refs: { WB_API_KEY: 'wb' } }, async () => {
      kept += 1
    })
    expect(kept).toBe(0)

    await applyKeys(port, { refs: { WB_API_KEY: 'newer', OFOX_API_KEY: 'ofox' } }, async () => {
      kept += 1
    })
    expect(kept).toBe(1)
  })

  it('reports the key a shadowed or broken store refused, and goes on to the next', async () => {
    const port = store({}, { refuse: ['WB_API_KEY'] })
    const result = await applyKeys(port, { refs: { OFOX_API_KEY: 'ofox', WB_API_KEY: 'wb' } })
    expect(result.problems.map((problem) => problem.ref)).toEqual(['WB_API_KEY'])
    expect(result.problems[0]?.message).toContain('read-only source shadows')
    // The one that went in is still named, refusal or no refusal: the two lists
    // say what happened to each key, and neither hides the other's work.
    expect(result.written).toEqual(['OFOX_API_KEY'])
    expect(port.written).toEqual([{ ref: 'OFOX_API_KEY', value: 'ofox' }])
  })

  it('never deletes a key, however the part reads', async () => {
    // `null` is the merge saying the part was taken away. There is no route from
    // that to a removal here: a credential a person stored by hand is not this
    // plugin's to throw away.
    const port = store({ WB_API_KEY: 'wb' })
    const nothing = { written: [], problems: [] }
    expect(await applyKeys(port, null)).toEqual(nothing)
    expect(await applyKeys(port, undefined)).toEqual(nothing)
    expect(await applyKeys(port, { refs: {} })).toEqual(nothing)
    expect(port.written).toEqual([])
  })

  it('says the store is missing when the host has none', async () => {
    const result = await applyKeys(undefined, { refs: { WB_API_KEY: 'wb' } })
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]?.ref).toBe('')
    expect(result.written).toEqual([])
  })

  it('passes a real service through unchanged, under the name this module uses', async () => {
    const written: string[] = []
    const port = keysPort({
      resolve: async () => undefined,
      set: async (ref) => {
        written.push(ref)
      },
    })
    await applyKeys(port, { refs: { WB_API_KEY: 'wb' } })
    expect(written).toEqual(['WB_API_KEY'])
  })
})

describe('merging two lists of keys', () => {
  it('keeps the names from both sides, with this computer’s value for a shared one', () => {
    // A key list is a set, not a document: two computers adding different keys is
    // not a conflict to resolve, and one side winning outright would silently drop
    // the other's.
    expect(
      unionKeys({ refs: { WB_API_KEY: 'wb-here' } }, { refs: { WB_API_KEY: 'wb-theirs', OFOX_API_KEY: 'ofox' } }),
    ).toEqual({ refs: { WB_API_KEY: 'wb-here', OFOX_API_KEY: 'ofox' } })
  })

  it('takes whatever one side has when the other has nothing readable', () => {
    expect(unionKeys({ refs: { WB_API_KEY: 'wb' } }, undefined)).toEqual({ refs: { WB_API_KEY: 'wb' } })
    expect(unionKeys(undefined, { refs: { WB_API_KEY: 'wb' } })).toEqual({ refs: { WB_API_KEY: 'wb' } })
    expect(unionKeys({ refs: { WB_API_KEY: 'wb' } }, 'not a part')).toEqual({ refs: { WB_API_KEY: 'wb' } })
    expect(unionKeys(undefined, null)).toEqual({ refs: {} })
  })

  it('drops a nameless or valueless entry rather than storing it', () => {
    expect(unionKeys(undefined, { refs: { '': 'nameless', WB_API_KEY: '', OFOX_API_KEY: 'ofox' } }))
      .toEqual({ refs: { OFOX_API_KEY: 'ofox' } })
  })
})

describe('the keys part in a sync', () => {
  it('carries this computer’s keys to the server', async () => {
    const paths = await writeProfile(TWO_PROVIDERS)
    const dav = serve()
    const port = store({ WB_API_KEY: 'wb-secret', GITHUB_HOOK_SECRET: 'hook-secret' })

    await sync(engineFor(paths, config(), port))

    expect((await readRemote(dav)).keys).toEqual({
      refs: { GITHUB_HOOK_SECRET: 'hook-secret', WB_API_KEY: 'wb-secret' },
    })
  })

  it('brings the server’s keys into this computer’s store', async () => {
    const paths = await writeProfile(TWO_PROVIDERS)
    const dav = serve()
    await seedRemote(dav, {
      models: { config: { providers: { wb: { displayName: '歪比巴布', apiKeyEnv: 'WB_API_KEY' } } } },
      keys: { refs: { WB_API_KEY: 'from-the-other-computer' } },
    })
    const port = store()

    const result = await sync(engineFor(paths, config(), port))

    expect(result.here).toContain('keys')
    expect(port.written).toEqual([{ ref: 'WB_API_KEY', value: 'from-the-other-computer' }])
    expect(result.keysProblems).toBeUndefined()
  })

  it('keeps the keys both computers added, and names the ones that arrived', async () => {
    // The case the union exists for: each side added a key the other has never
    // seen. Taking the newer list would report a successful sync and lose keys.
    const paths = await writeProfile(TWO_PROVIDERS)
    const dav = serve()
    const port = store({ WB_API_KEY: 'wb-here' })
    const engine = engineFor(paths, config(), port)
    await sync(engine)

    await port.store('WB_API_KEY', 'wb-edited-here')
    const previous = await readRemote(dav)
    await seedRemote(dav, {
      ...previous,
      keys: { refs: { WB_API_KEY: 'wb-theirs', GITHUB_HOOK_SECRET: 'hook-theirs' } },
    }, new Date(Date.now() + 60_000).toISOString())

    const planned = await preview(engine)
    expect(planned.changes).toContainEqual({ part: 'keys', take: 'both' })

    const result = await sync(engine)

    // The server is newer, and its new key still arrives — while this computer's
    // edit to the name they share stands.
    expect(await port.resolve('WB_API_KEY')).toMatchObject({ value: 'wb-edited-here' })
    expect(await port.resolve('GITHUB_HOOK_SECRET')).toMatchObject({ value: 'hook-theirs' })
    expect(result.keysWritten).toEqual(['GITHUB_HOOK_SECRET'])
    expect(result.there).toContain('keys')
    expect((await readRemote(dav)).keys).toEqual({
      refs: { GITHUB_HOOK_SECRET: 'hook-theirs', WB_API_KEY: 'wb-edited-here' },
    })
  })

  it('reports a key this computer’s store would not take', async () => {
    // The sync did its job and still left a provider unauthenticated. Saying so is
    // the difference between a bug report and a mystery.
    const paths = await writeProfile(TWO_PROVIDERS)
    const dav = serve()
    await seedRemote(dav, {
      models: { config: { providers: { wb: { displayName: '歪比巴布', apiKeyEnv: 'WB_API_KEY' } } } },
      keys: { refs: { WB_API_KEY: 'theirs' } },
    })
    const port = store({}, { refuse: ['WB_API_KEY'] })

    const result = await sync(engineFor(paths, config(), port))

    expect(result.keysProblems?.map((problem) => problem.ref)).toEqual(['WB_API_KEY'])
  })

  it('reads and writes nothing when the part is switched off, and deletes nothing', async () => {
    const paths = await writeProfile(TWO_PROVIDERS)
    const dav = serve()
    await seedRemote(dav, {
      models: { config: { providers: { wb: { displayName: '歪比巴布', apiKeyEnv: 'WB_API_KEY' } } } },
      keys: { refs: { WB_API_KEY: 'theirs' } },
    })
    const port = store({ WB_API_KEY: 'mine' })

    await sync(engineFor(paths, config({ keys: false }), port))

    // Untouched here, and carried through there: turning a part off is a statement
    // about this computer, never an instruction to delete somebody else's key.
    expect(port.written).toEqual([])
    expect((await readRemote(dav)).keys).toEqual({ refs: { WB_API_KEY: 'theirs' } })
  })

  it('never sends an empty part for a store it could not read', async () => {
    // The failure this part's problems list exists to prevent: reading a broken
    // store as "no keys" would push `{ refs: {} }` and, on the next sync, look
    // like this computer deleted every key it has.
    const paths = await writeProfile(TWO_PROVIDERS)
    const dav = serve()
    const port = broken()

    const result = await sync(engineFor(paths, config(), port))

    expect(result.pushed).toBe(true)
    expect((await readRemote(dav)).keys).toBeUndefined()
  })

  it('keeps the server’s keys when the credential service temporarily disappears, then retries', async () => {
    const paths = await writeProfile(TWO_PROVIDERS)
    const dav = serve()
    const port = store({ WB_API_KEY: 'stored-key' })
    const engine = engineFor(paths, config(), port)
    await sync(engine)

    engine.credentials = undefined
    const unavailable = await sync(engine)
    expect(unavailable.keysProblems).toEqual([expect.objectContaining({ ref: '' })])
    expect((await readRemote(dav)).keys).toEqual({ refs: { WB_API_KEY: 'stored-key' } })

    await port.store('WB_API_KEY', 'updated-key')
    engine.credentials = port
    const retried = await sync(engine)
    expect(retried.keysProblems).toBeUndefined()
    expect((await readRemote(dav)).keys).toEqual({ refs: { WB_API_KEY: 'updated-key' } })
    expect((await status(engine)).parts.find((part) => part.part === 'keys')).toMatchObject({
      localChanged: false, remoteChanged: false,
    })
  })

  it('adopts server keys after a first sync could not establish a credential baseline', async () => {
    const paths = await writeProfile(TWO_PROVIDERS)
    const dav = serve()
    const remote = {
      refs: {
        WB_API_KEY: 'remote-wb',
        OFOX_API_KEY: 'remote-ofox',
        GITHUB_HOOK_SECRET: 'remote-hook',
      },
    }
    await seedRemote(dav, { keys: remote })
    const values = store({ WB_API_KEY: 'local-wb' })
    const unavailable: KeysPort = {
      resolve: async (ref) => {
        if (ref === 'WB_API_KEY') throw new Error('credential store locked')
        return values.resolve(ref)
      },
      store: (ref, value) => values.store(ref, value),
    }
    const engine = engineFor(paths, config(), unavailable)
    const first = await sync(engine)
    expect(first.keysProblems).toEqual([expect.objectContaining({ ref: 'WB_API_KEY' })])
    expect((await readRemote(dav)).keys).toEqual(remote)

    engine.credentials = values
    const recovered = await sync(engine)
    expect(recovered.keysProblems).toBeUndefined()
    expect(recovered.here).toContain('keys')
    expect((await values.resolve('WB_API_KEY'))?.value).toBe('remote-wb')
    expect((await values.resolve('OFOX_API_KEY'))?.value).toBe('remote-ofox')
    expect((await values.resolve('GITHUB_HOOK_SECRET'))?.value).toBe('remote-hook')
    expect((await readRemote(dav)).keys).toEqual(remote)
  })

  it('retries server key changes after an unreadable store without accepting them as already applied', async () => {
    const paths = await writeProfile(TWO_PROVIDERS)
    const dav = serve()
    const port = store({ WB_API_KEY: 'original-key' })
    const engine = engineFor(paths, config(), port)
    await sync(engine)
    const previous = await readRemote(dav)

    engine.credentials = undefined
    await seedRemote(dav, { ...previous, keys: { refs: { WB_API_KEY: 'from-other-computer' } } })
    const deferred = await sync(engine)
    expect(deferred.keysProblems).toEqual([expect.objectContaining({ ref: '' })])
    expect((await port.resolve('WB_API_KEY'))?.value).toBe('original-key')
    expect((await readRemote(dav)).keys).toEqual({ refs: { WB_API_KEY: 'from-other-computer' } })

    engine.credentials = port
    const retried = await sync(engine)
    expect(retried.keysProblems).toBeUndefined()
    expect(retried.here).toContain('keys')
    expect((await port.resolve('WB_API_KEY'))?.value).toBe('from-other-computer')
    expect((await status(engine)).parts.find((part) => part.part === 'keys')).toMatchObject({
      localChanged: false, remoteChanged: false,
    })
  })

  it('defers the whole keys part rather than replacing the server with a partial read', async () => {
    const paths = await writeProfile(TWO_PROVIDERS)
    const dav = serve()
    const held = store({ WB_API_KEY: 'wb-stored', OFOX_API_KEY: 'ofox-stored' })
    let unreadable = false
    const port: KeysPort = {
      resolve: async (ref) => {
        if (unreadable && ref === 'WB_API_KEY') throw new Error('store temporarily locked')
        return held.resolve(ref)
      },
      store: (ref, value) => held.store(ref, value),
    }
    const engine = engineFor(paths, config(), port)
    await sync(engine)
    unreadable = true
    await held.store('OFOX_API_KEY', 'ofox-updated')

    const unavailable = await sync(engine)
    expect(unavailable.keysProblems).toEqual([expect.objectContaining({ ref: 'WB_API_KEY' })])
    expect((await readRemote(dav)).keys).toEqual({
      refs: { WB_API_KEY: 'wb-stored', OFOX_API_KEY: 'ofox-stored' },
    })

    unreadable = false
    await sync(engine)
    expect((await readRemote(dav)).keys).toEqual({
      refs: { WB_API_KEY: 'wb-stored', OFOX_API_KEY: 'ofox-updated' },
    })
  })

  it('reports credential read problems even when an unchanged server takes the fast path', async () => {
    const paths = await writeProfile(TWO_PROVIDERS)
    serve()
    const engine = engineFor(paths, config(), broken('the store is locked'))
    const first = await sync(engine)
    expect(first.keysProblems?.map((problem) => problem.ref)).toEqual([
      'GITHUB_HOOK_SECRET', 'OFOX_API_KEY', 'WB_API_KEY',
    ])
    const again = await sync(engine)
    expect(again.pushed).toBe(false)
    expect(again.keysProblems).toEqual(first.keysProblems)
  })

  it('promises no key upload in the preview when one name cannot be read', async () => {
    // The preview and the sync have to answer with one voice. One unreadable name
    // defers the whole part — a partial read must never go up, or the next sync
    // would read the missing name as a deletion — so the card must not list the
    // part as going up either.
    const paths = await writeProfile(TWO_PROVIDERS)
    const dav = serve()
    const held = store({ OFOX_API_KEY: 'ofox-stored', GITHUB_HOOK_SECRET: 'hook-stored' })
    const port: KeysPort = {
      resolve: async (ref) => {
        if (ref === 'WB_API_KEY') throw new Error('store temporarily locked')
        return held.resolve(ref)
      },
      store: (ref, value) => held.store(ref, value),
    }
    const engine = engineFor(paths, config(), port)

    const shown = await preview(engine)
    expect(shown.changes.map((change) => change.part)).not.toContain('keys')
    expect(shown.changes.map((change) => change.part)).toContain('models')

    const result = await sync(engine)
    expect(result.pushed).toBe(true)
    expect((await readRemote(dav)).keys).toBeUndefined()
  })

  it('says on the status which name it could not read', async () => {
    const paths = await writeProfile(TWO_PROVIDERS)
    serve()
    const view = await status(engineFor(paths, config(), broken('the store is locked')))

    expect(view.keysProblems?.map((problem) => problem.ref)).toEqual([
      'GITHUB_HOOK_SECRET',
      'OFOX_API_KEY',
      'WB_API_KEY',
    ])
    expect(view.keysProblems?.[0]?.message).toContain('the store is locked')
    expect(view.parts.map((part) => part.part)).toContain('keys')
  })

  it('refuses a server file whose keys part is not a map of names to values', async () => {
    const paths = await writeProfile(TWO_PROVIDERS)
    const dav = serve()
    await seedRemote(dav, {
      models: { config: { providers: { wb: { displayName: '歪比巴布', apiKeyEnv: 'WB_API_KEY' } } } },
      // A part this plugin did not write. Reading it as empty would be a lie about
      // what the server holds, so it is named as unreadable like any other.
      keys: { refs: { WB_API_KEY: 7 } } as unknown as { refs: Record<string, string> },
    })

    await expect(sync(engineFor(paths, config(), store()))).rejects.toThrow(/keys/)
  })

  it('keeps the key it replaces, so undo has something to put back', async () => {
    const paths = await writeProfile(TWO_PROVIDERS)
    const dav = serve()
    const port = store({ WB_API_KEY: 'mine' })
    const engine = engineFor(paths, config(), port)
    await sync(engine)

    await seedRemote(
      dav,
      {
        models: { config: { providers: { wb: { displayName: '歪比巴布', apiKeyEnv: 'WB_API_KEY' } } } },
        keys: { refs: { WB_API_KEY: 'theirs' } },
      },
      new Date(Date.now() + 600_000).toISOString(),
    )

    await sync(engine)
    expect(port.written.at(-1)).toEqual({ ref: 'WB_API_KEY', value: 'theirs' })
    // The copy the merge kept is sealed in the sync folder before the key was
    // replaced: overwriting a credential without one would leave Undo with nothing
    // to put back.
    const names = await readdir(keptDir(paths))
    expect(names.some((name) => name.includes('before-apply'))).toBe(true)
  })
})

describe('the keys part against a real credential file', () => {
  it('travels through the shape DSH itself writes', async () => {
    // The store's own layout is `version: 1` with `refs:` under it; a name is a
    // POSIX identifier and a value a non-empty string. Anything this plugin sends
    // has to be readable by that file's rules, so the part is checked against them.
    const file = await writeProfile(TWO_PROVIDERS)
    const port = store({ WB_API_KEY: 'wb-secret' })
    const read = await readKeys(port, { models: { config: { providers: { wb: { apiKeyEnv: 'WB_API_KEY' } } } } })
    expect(read.part?.refs).toEqual({ WB_API_KEY: 'wb-secret' })
    expect(Object.keys(read.part?.refs ?? {}).every((ref) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref))).toBe(true)
    // The profile file is never touched by any of it: a key does not live there.
    expect(await readFile(file.patchFile, 'utf8')).toBe(TWO_PROVIDERS)
  })
})
