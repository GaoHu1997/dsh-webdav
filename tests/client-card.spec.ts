/**
 * The card's state and its writes.
 *
 * `WebdavSyncCard` is the browser half's whole brain and had no test at all: it
 * is driven here through its own `actions()`, with `fetch` stubbed, so the
 * things that decide what a user sees are pinned: a refused write becomes a
 * message instead of an escaping rejection, a secret is never read back into
 * the draft, and a call that succeeded is not drawn as a failure.
 *
 * That last one is why this file exists. `run()` strips the transport's own
 * `ok` off an answer and hands the rest to each action's `describe`, and two
 * actions used to go looking for that same `ok` again — finding nothing, and
 * reporting every success as a failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signatureOf, WebdavSyncCard } from '../src/client/card-store.ts'
import type { CardState } from '../src/client/card-store.ts'
import { DIRS_MAX, RELAY_DEFAULT_PORT, ROUTE_CONFIG, ROUTE_DISMISS, ROUTE_STATUS, ROUTE_SYNC } from '../src/wire.ts'
import type { CheckResult, ConfigView, InstallResult, RelayView, StatusResult } from '../src/wire.ts'

/** One recorded request, so a test can assert on what was sent. */
interface Sent {
  url: string
  method: string
  body: unknown
}

let sent: Sent[] = []

/** Answer every request with a fixed payload. */
function replies(payload: unknown, status = 200): void {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    sent.push({
      url: String(url),
      method: String(init.method ?? 'GET'),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
}

/** Answer each request with the next payload in a row. */
function repliesInTurn(...payloads: unknown[]): void {
  let index = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const payload = payloads[Math.min(index, payloads.length - 1)]
    index += 1
    sent.push({
      url: String(url),
      method: String(init.method ?? 'GET'),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

const CONFIG: ConfigView = {
  url: 'https://dav.test/dav',
  user: 'me',
  passwordSet: true,
  passphraseSet: true,
  autoEvery: -1,
  models: true,
  plugins: true,
  patch: true,
  keys: true,
  dirs: [],
  dirsEnabled: true,
  rememberPassword: true,
  headers: '',
  relayEnabled: false,
  relayPort: RELAY_DEFAULT_PORT,
}

const RELAY: RelayView = {
  enabled: true,
  port: RELAY_DEFAULT_PORT,
  url: `http://127.0.0.1:${RELAY_DEFAULT_PORT}/dav`,
  user: 'dshcafe',
  password: '0123456789abcdef0123456789abcdef',
  listening: true,
  error: '',
}

function status(over: Partial<StatusResult> = {}): StatusResult {
  return {
    configured: true,
    config: CONFIG,
    paths: {
      profileDir: '/p',
      stateDir: '/p/.dsh-webdav-sync',
      patchFile: '/p/cordis.patch.yml',
      packageFile: '/p/package.json',
    },
    error: '',
    parts: [],
    pendingInstall: false,
    undoable: false,
    ...over,
  }
}

/** A card that has read one status, ready to act. */
async function ready(
  over: Partial<StatusResult> = {},
  choose?: () => Promise<string | null>,
): Promise<{ card: WebdavSyncCard; actions: ReturnType<WebdavSyncCard['actions']> }> {
  replies({ ...status(over), ok: true })
  const card = new WebdavSyncCard(choose)
  await card.load()
  return { card, actions: card.actions() }
}

beforeEach(() => {
  sent = []
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('reading the status', () => {
  it('starts loading, then holds what the host reported', async () => {
    const card = new WebdavSyncCard()
    expect(card.getSnapshot().phase).toBe('loading')
    expect(card.getSnapshot().view).toBeUndefined()
    replies({ ...status(), ok: true })
    await card.load()
    const state = card.getSnapshot()
    expect(state.phase).toBe('ready')
    expect(state.error).toBe('')
    expect(state.view?.configured).toBe(true)
  })

  it('seeds the draft but never reads a secret back into it', async () => {
    const { card } = await ready()
    const state = card.getSnapshot()
    expect(state.url).toBe('https://dav.test/dav')
    expect(state.user).toBe('me')
    // The host sends booleans, so the inputs start blank: blank is "keep it".
    expect(state.password).toBe('')
    expect(state.passphrase).toBe('')
    expect(state.view?.config.passwordSet).toBe(true)
    expect(state.dirty).toBe(false)
  })

  it('keeps a refused read as a message rather than throwing', async () => {
    replies({ error: 'nope' }, 500)
    const card = new WebdavSyncCard()
    await card.load()
    const state = card.getSnapshot()
    expect(state.phase).toBe('ready')
    expect(state.error).toBe('nope')
    expect(state.view).toBeUndefined()
  })

  it('lets a timer read refresh the view without reaching into a draft being typed', async () => {
    // The card reads the status on a timer so the times move while the page is
    // open; that read must never take back what has been typed since.
    const lastSync = '2026-10-21T05:34:43.000Z'
    const lastCheck = '2026-10-21T06:40:58.000Z'
    const { card, actions } = await ready({ last: lastSync, moved: lastSync })
    actions.edit('url', 'https://half-typed.test/dav')
    replies({ ...status({ last: lastCheck, moved: lastSync }), ok: true })
    actions.poll()
    await vi.waitFor(() => {
      expect(card.getSnapshot().view?.last).toBe(lastCheck)
    })
    expect(card.getSnapshot().view?.moved).toBe(lastSync)
    expect(card.getSnapshot().url).toBe('https://half-typed.test/dav')
    expect(card.getSnapshot().dirty).toBe(true)

    replies({ ...status({ last: lastCheck, moved: lastCheck }), ok: true })
    actions.poll()
    await vi.waitFor(() => {
      expect(card.getSnapshot().view?.moved).toBe(lastCheck)
    })
    expect(card.getSnapshot().url).toBe('https://half-typed.test/dav')
    expect(card.getSnapshot().dirty).toBe(true)
  })

  it('takes a timer read whole when nothing has been typed', async () => {
    // Nothing is being edited, so there is nothing to protect: a change made on
    // the host reaches the form itself, which is what makes an interval changed
    // in another window show up here.
    const { card, actions } = await ready()
    replies({ ...status({ config: { ...CONFIG, autoEvery: 15 } }), ok: true })
    actions.poll()
    await vi.waitFor(() => {
      expect(card.getSnapshot().autoEvery).toBe(15)
    })
    expect(card.getSnapshot().dirty).toBe(false)
  })

  it('keeps the last known status, reports polling failures, and recovers on retry', async () => {
    const { card, actions } = await ready({ last: '2026-10-21T09:20:23.000Z' })
    const before = card.getSnapshot().view
    actions.edit('url', 'https://half-typed.test/dav')
    replies({ error: 'the host is not there' }, 500)
    actions.poll()
    await vi.waitFor(() => {
      expect(card.getSnapshot().error).toBe('the host is not there')
    })
    expect(card.getSnapshot().view).toBe(before)
    expect(card.getSnapshot().url).toBe('https://half-typed.test/dav')

    replies(status({ last: '2026-10-21T09:29:24.000Z' }))
    actions.poll()
    await vi.waitFor(() => expect(card.getSnapshot().error).toBe(''))
    expect(card.getSnapshot().view?.last).toBe('2026-10-21T09:29:24.000Z')
    expect(card.getSnapshot().dirty).toBe(true)
  })
})

describe('status refresh recovery', () => {
  it('manual refresh only reads local status and keeps unsaved secrets and fields', async () => {
    const { card, actions } = await ready()
    actions.edit('url', 'https://draft.test')
    actions.edit('password', 'unsaved-password')
    actions.edit('passphrase', 'unsaved-passphrase')
    sent = []
    replies(status({ last: '2026-10-21T09:29:24.000Z' }))
    actions.refresh()
    await vi.waitFor(() => expect(card.getSnapshot().view?.last).toBe('2026-10-21T09:29:24.000Z'))
    expect(sent).toEqual([{ url: ROUTE_STATUS, method: 'GET', body: undefined }])
    expect(card.getSnapshot()).toMatchObject({
      url: 'https://draft.test', password: 'unsaved-password', passphrase: 'unsaved-passphrase', dirty: true,
    })
  })

  it.each(['fetch', 'body'])('times out a hanging %s, deduplicates polls and retries successfully', async (stage) => {
    const { card, actions } = await ready({ last: '2026-10-21T09:20:23.000Z' })
    vi.useFakeTimers()
    const never = new Promise<never>(() => {})
    const fetchMock = vi.fn((_url: string, _init: RequestInit) => stage === 'fetch'
      ? never
      : Promise.resolve({ ok: true, status: 200, json: () => never } as unknown as Response))
    vi.stubGlobal('fetch', fetchMock)
    actions.poll()
    actions.poll()
    actions.refresh()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(card.getSnapshot().error).toContain('超时')
    expect(card.getSnapshot().view?.last).toBe('2026-10-21T09:20:23.000Z')
    expect(fetchMock.mock.calls[0]?.[1].signal?.aborted).toBe(true)

    replies(status({ last: '2026-10-21T09:29:24.000Z' }))
    actions.poll()
    await vi.advanceTimersByTimeAsync(0)
    expect(card.getSnapshot().view?.last).toBe('2026-10-21T09:29:24.000Z')
    expect(card.getSnapshot().error).toBe('')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('recovers automatically when the initial status request times out', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', () => new Promise<never>(() => {}))
    const card = new WebdavSyncCard()
    card.ensure()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(card.getSnapshot().phase).toBe('ready')
    expect(card.getSnapshot().error).toContain('超时')
    replies(status())
    card.poll()
    await vi.advanceTimersByTimeAsync(0)
    expect(card.getSnapshot().view?.configured).toBe(true)
    expect(card.getSnapshot().error).toBe('')
  })

  it.each([200, 500])('ignores a late polling response (%s) after a newer status load', async (code) => {
    const { card, actions } = await ready()
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => { finish = resolve }))
    actions.poll()
    replies(status({ last: '2026-10-21T09:29:24.000Z' }))
    await card.load()
    finish(new Response(JSON.stringify(code === 200
      ? status({ last: '2026-10-21T09:20:23.000Z' })
      : { error: 'late failure' }), { status: code }))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(card.getSnapshot().view?.last).toBe('2026-10-21T09:29:24.000Z')
    expect(card.getSnapshot().error).toBe('')
  })

  it('does not start a polling request during a post-action status load', async () => {
    const { card, actions } = await ready()
    let finish!: (response: Response) => void
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const loading = card.load()
    actions.poll()
    actions.refresh()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    finish(new Response(JSON.stringify(status())))
    await loading
  })
})

describe('the draft', () => {
  it('marks itself dirty on an edit, a toggle and a new interval', async () => {
    const { card, actions } = await ready()
    actions.edit('url', 'https://other.test/dav')
    expect(card.getSnapshot().url).toBe('https://other.test/dav')
    expect(card.getSnapshot().dirty).toBe(true)

    actions.toggle('plugins', false)
    expect(card.getSnapshot().plugins).toBe(false)

    actions.setAuto(15)
    expect(card.getSnapshot().autoEvery).toBe(15)
  })

  it('ignores an interval that is not one of the choices', async () => {
    const { card } = await ready()
    card.setAuto(7)
    expect(card.getSnapshot().autoEvery).toBe(-1)
    expect(card.getSnapshot().dirty).toBe(false)
  })

  it('puts every staged field back on reset', async () => {
    const { card, actions } = await ready()
    actions.edit('url', 'https://other.test/dav')
    actions.edit('password', 'typed')
    actions.toggle('models', false)
    actions.reset()
    const state = card.getSnapshot()
    expect(state.url).toBe('https://dav.test/dav')
    expect(state.password).toBe('')
    expect(state.models).toBe(true)
    expect(state.dirty).toBe(false)
  })

  it('only tells its listeners when something actually changed', async () => {
    const { card } = await ready()
    let calls = 0
    card.subscribe(() => {
      calls += 1
    })
    card.edit('url', 'https://other.test/dav')
    expect(calls).toBe(1)
    // The same value typed in again moves nothing, so nobody is told.
    card.edit('url', 'https://other.test/dav')
    expect(calls).toBe(1)
  })

  it('carries the configured headers between the view and the save body', async () => {
    // Headers are not a secret, so unlike the password they are seeded back
    // into the draft as typed: the textarea must show what is stored.
    const { card, actions } = await ready({ config: { ...CONFIG, headers: 'X-A: 1' } })
    expect(card.getSnapshot().headers).toBe('X-A: 1')
    actions.edit('headers', 'X-A: 2')
    expect(card.getSnapshot().dirty).toBe(true)
    repliesInTurn({ ok: true }, { ...status(), ok: true })
    actions.save()
    await vi.waitFor(() => {
      expect(sent.some((entry) => entry.url.includes('/plugin/webdav-sync/config'))).toBe(true)
    })
    const body = sent.find((entry) => entry.url.includes('/plugin/webdav-sync/config'))?.body as { headers?: string }
    expect(body.headers).toBe('X-A: 2')
  })
})

describe('local forwarding shares the sync card', () => {
  it('reads the switch and port from config and keeps the generated account only in the relay view', async () => {
    const { card } = await ready({ config: { ...CONFIG, relayEnabled: true, relayPort: 4326 }, relay: { ...RELAY, port: 4326, url: 'http://127.0.0.1:4326/dav' } })
    const state = card.getSnapshot()
    expect(state.relayEnabled).toBe(true)
    expect(state.relayPort).toBe(4326)
    expect(state.view?.relay).toMatchObject({ url: 'http://127.0.0.1:4326/dav', user: RELAY.user, password: RELAY.password })
    expect(state.user).toBe(CONFIG.user)
    expect(state.password).toBe('')
    expect(state.passphrase).toBe('')
    expect(state).not.toHaveProperty('relayUser')
    expect(state).not.toHaveProperty('relayPassword')
    expect(state.dirty).toBe(false)
    expect(sent.map(({ url, method }) => ({ url, method }))).toEqual([{ url: ROUTE_STATUS, method: 'GET' }])
  })

  it('reads a host without relay fields as forwarding off on the default port', async () => {
    const legacy = { ...CONFIG } as Partial<ConfigView>
    delete legacy.relayEnabled
    delete legacy.relayPort
    const { card } = await ready({ config: legacy as ConfigView })
    expect(card.getSnapshot()).toMatchObject({ relayEnabled: false, relayPort: RELAY_DEFAULT_PORT, dirty: false })
    expect(card.getSnapshot().view?.relay).toBeUndefined()
  })

  it('only stages the checkbox and port until the shared save, and restores both on reset', async () => {
    const { card, actions } = await ready()
    sent = []
    actions.toggle('relayEnabled', true)
    actions.nextPort()
    expect(card.getSnapshot()).toMatchObject({ relayEnabled: true, relayPort: RELAY_DEFAULT_PORT + 1, dirty: true })
    expect(sent).toEqual([])
    actions.reset()
    expect(card.getSnapshot()).toMatchObject({ relayEnabled: false, relayPort: RELAY_DEFAULT_PORT, dirty: false })
    expect(sent).toEqual([])
  })

  it('stops incrementing at the last valid port without wrapping or changing a clean draft', async () => {
    const { card, actions } = await ready({ config: { ...CONFIG, relayPort: 65_534 } })
    actions.nextPort()
    expect(card.getSnapshot()).toMatchObject({ relayPort: 65_535, dirty: true })
    const atLimit = card.getSnapshot()
    actions.nextPort()
    expect(card.getSnapshot()).toBe(atLimit)

    const { card: clean, actions: cleanActions } = await ready({ config: { ...CONFIG, relayPort: 65_535 } })
    const before = clean.getSnapshot()
    cleanActions.nextPort()
    expect(clean.getSnapshot()).toBe(before)
    expect(clean.getSnapshot().dirty).toBe(false)
  })

  it('posts the relay switch and port once with the upstream draft, never the generated credentials', async () => {
    const { card, actions } = await ready({ relay: RELAY })
    actions.edit('url', 'https://other.test/dav')
    actions.edit('user', 'other-user')
    actions.edit('password', 'typed-upstream-password')
    actions.edit('passphrase', 'typed-backup-passphrase')
    actions.edit('headers', 'X-Proxy: shared')
    actions.toggle('relayEnabled', true)
    actions.nextPort()
    sent = []
    const savedConfig = {
      ...CONFIG, url: 'https://other.test/dav', user: 'other-user', headers: 'X-Proxy: shared',
      relayEnabled: true, relayPort: RELAY_DEFAULT_PORT + 1,
    }
    const savedRelay = { ...RELAY, port: RELAY_DEFAULT_PORT + 1, url: `http://127.0.0.1:${RELAY_DEFAULT_PORT + 1}/dav` }
    repliesInTurn({ message: '已保存' }, { ...status({ config: savedConfig, relay: savedRelay }) })
    actions.save()
    await vi.waitFor(() => {
      expect(card.getSnapshot().view?.config.relayEnabled).toBe(true)
      expect(card.getSnapshot().dirty).toBe(false)
    })
    expect(sent.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: ROUTE_CONFIG, method: 'POST' },
      { url: ROUTE_STATUS, method: 'GET' },
    ])
    expect(sent[0]?.body).toEqual({
      url: 'https://other.test/dav', user: 'other-user', password: 'typed-upstream-password',
      passphrase: 'typed-backup-passphrase', headers: 'X-Proxy: shared', autoEvery: -1,
      models: true, plugins: true, patch: true, keys: true,
      dirs: [], dirsEnabled: true, rememberPassword: true,
      relayEnabled: true, relayPort: RELAY_DEFAULT_PORT + 1,
    })
    expect(sent[0]?.body).not.toHaveProperty('relayUser')
    expect(sent[0]?.body).not.toHaveProperty('relayPassword')
    expect(JSON.stringify(sent[0]?.body)).not.toContain(RELAY.password)
    expect(card.getSnapshot().password).toBe('')
    expect(card.getSnapshot().passphrase).toBe('')
    expect(card.getSnapshot().view?.relay).toEqual(savedRelay)
  })

  it('shows the account minted by the first save without putting it in the upstream password input', async () => {
    const { card, actions } = await ready()
    expect(card.getSnapshot().view?.relay).toBeUndefined()
    actions.toggle('relayEnabled', true)
    repliesInTurn({ message: '已保存' }, status({ config: { ...CONFIG, relayEnabled: true }, relay: RELAY }))
    actions.save()
    await vi.waitFor(() => {
      expect(card.getSnapshot().view?.relay?.password).toBe(RELAY.password)
    })
    expect(card.getSnapshot().view?.relay?.user).toBe(RELAY.user)
    expect(card.getSnapshot().user).toBe(CONFIG.user)
    expect(card.getSnapshot().password).toBe('')
    expect(card.getSnapshot().dirty).toBe(false)
  })

  it('sends a disabled checkbox through the same config write while keeping the account in the refreshed view', async () => {
    const { card, actions } = await ready({ config: { ...CONFIG, relayEnabled: true }, relay: RELAY })
    actions.toggle('relayEnabled', false)
    sent = []
    const stopped = { ...RELAY, enabled: false, listening: false, url: '' }
    repliesInTurn({ message: '已保存' }, status({ relay: stopped }))
    actions.save()
    await vi.waitFor(() => {
      expect(card.getSnapshot().view?.relay?.enabled).toBe(false)
    })
    expect(sent.filter(({ method }) => method === 'POST')).toEqual([
      expect.objectContaining({ url: ROUTE_CONFIG, body: expect.objectContaining({ relayEnabled: false, relayPort: RELAY_DEFAULT_PORT }) }),
    ])
    expect(sent[0]?.body).not.toHaveProperty('relayUser')
    expect(sent[0]?.body).not.toHaveProperty('relayPassword')
    expect(card.getSnapshot().view?.relay).toEqual(stopped)
    expect(card.getSnapshot().relayEnabled).toBe(false)
  })

  it('refreshes relay status during a poll without overwriting any staged upstream or relay field', async () => {
    const { card, actions } = await ready({ config: { ...CONFIG, relayEnabled: true }, relay: RELAY })
    actions.edit('url', 'https://draft.test/new-dav')
    actions.edit('user', 'draft-user')
    actions.edit('password', 'draft-password')
    actions.edit('passphrase', 'draft-passphrase')
    actions.edit('headers', 'X-Draft: keep')
    actions.toggle('relayEnabled', false)
    actions.nextPort()
    const updatedConfig = { ...CONFIG, url: 'https://changed-on-host.test/dav', relayEnabled: true, relayPort: 4567 }
    const updatedRelay = { ...RELAY, port: 4567, url: 'http://127.0.0.1:4567/dav', listening: false, error: 'port in use' }
    sent = []
    replies(status({ config: updatedConfig, relay: updatedRelay }))
    actions.poll()
    await vi.waitFor(() => {
      expect(card.getSnapshot().view?.relay?.error).toBe('port in use')
    })
    expect(card.getSnapshot().view?.relay).toEqual(updatedRelay)
    expect(card.getSnapshot().view?.config).toEqual(updatedConfig)
    expect(card.getSnapshot()).toMatchObject({
      url: 'https://draft.test/new-dav', user: 'draft-user', password: 'draft-password',
      passphrase: 'draft-passphrase', headers: 'X-Draft: keep',
      relayEnabled: false, relayPort: RELAY_DEFAULT_PORT + 1, dirty: true,
    })
    expect(sent.map(({ url, method }) => ({ url, method }))).toEqual([{ url: ROUTE_STATUS, method: 'GET' }])
  })

  it('adopts relay switch and port changes from a poll when the draft is clean', async () => {
    const { card, actions } = await ready()
    const changed = { ...RELAY, port: 4567, url: 'http://127.0.0.1:4567/dav' }
    replies(status({ config: { ...CONFIG, relayEnabled: true, relayPort: 4567 }, relay: changed }))
    actions.poll()
    await vi.waitFor(() => {
      expect(card.getSnapshot().relayPort).toBe(4567)
    })
    expect(card.getSnapshot()).toMatchObject({ relayEnabled: true, dirty: false, password: '', passphrase: '' })
    expect(card.getSnapshot().view?.relay).toEqual(changed)
  })
})

describe('the extra directories', () => {
  /** Let every promise that is already resolved run out to its end. */
  async function flush(times = 4): Promise<void> {
    for (let round = 0; round < times; round += 1) await Promise.resolve()
  }

  it('stages the directory the picker hands back', async () => {
    const { card, actions } = await ready({}, async () => '/tmp/notes')
    actions.pickDir()
    await vi.waitFor(() => {
      expect(card.getSnapshot().dirs).toEqual(['/tmp/notes'])
    })
    expect(card.getSnapshot().dirty).toBe(true)
  })

  it('stages nothing when the picker comes back empty-handed', async () => {
    const { card, actions } = await ready({}, async () => null)
    actions.pickDir()
    // The dialog answered — it was cancelled — so no row is left behind.
    await flush()
    expect(card.getSnapshot().dirs).toEqual([])
    expect(card.getSnapshot().dirty).toBe(false)
  })

  it('leaves a row to type into when no dialog can be reached', async () => {
    const { card, actions } = await ready({}, async () => {
      throw new Error('no directory chooser is available here')
    })
    actions.pickDir()
    await vi.waitFor(() => {
      expect(card.getSnapshot().dirs).toEqual([''])
    })
    actions.editDir(0, '/tmp/by-hand')
    expect(card.getSnapshot().dirs).toEqual(['/tmp/by-hand'])
  })

  it('leaves that same row when the card was built with no chooser at all', async () => {
    const { card, actions } = await ready()
    actions.pickDir()
    expect(card.getSnapshot().dirs).toEqual([''])
  })

  it('never stages the same directory twice', async () => {
    const { card, actions } = await ready({}, async () => '/tmp/notes')
    actions.pickDir()
    await vi.waitFor(() => {
      expect(card.getSnapshot().dirs).toHaveLength(1)
    })
    let calls = 0
    card.subscribe(() => {
      calls += 1
    })
    // The second answer is the path already on the list: nothing moves, so
    // nobody is told and no duplicate row appears.
    actions.pickDir()
    await flush()
    expect(calls).toBe(0)
    expect(card.getSnapshot().dirs).toEqual(['/tmp/notes'])
  })

  it('takes one back out again', async () => {
    const { card, actions } = await ready({}, async () => '/tmp/notes')
    actions.pickDir()
    await vi.waitFor(() => {
      expect(card.getSnapshot().dirs).toHaveLength(1)
    })
    actions.removeDir(0)
    expect(card.getSnapshot().dirs).toEqual([])
  })

  it('stops at the cap however often it is asked', async () => {
    let n = 0
    const { card, actions } = await ready({}, async () => `/tmp/notes-${(n += 1)}`)
    for (let round = 0; round <= DIRS_MAX; round += 1) actions.pickDir()
    await vi.waitFor(() => {
      expect(card.getSnapshot().dirs).toHaveLength(DIRS_MAX)
    })
    expect(card.getSnapshot().dirs).toEqual(['/tmp/notes-1', '/tmp/notes-2', '/tmp/notes-3', '/tmp/notes-4', '/tmp/notes-5'])
  })

  it('sends the directories with the save body', async () => {
    const { card, actions } = await ready({}, async () => '/tmp/notes')
    actions.pickDir()
    await vi.waitFor(() => {
      expect(card.getSnapshot().dirs).toHaveLength(1)
    })
    repliesInTurn({ ok: true }, { ...status(), ok: true })
    actions.save()
    await vi.waitFor(() => {
      expect(sent.some((entry) => entry.url.includes('/plugin/webdav-sync/config'))).toBe(true)
    })
    const body = sent.find((entry) => entry.url.includes('/plugin/webdav-sync/config'))?.body as { dirs?: string[] }
    expect(body.dirs).toEqual(['/tmp/notes'])
  })

  it('carries the switch that turns the part off into the save body', async () => {
    const { card, actions } = await ready()
    // The draft starts from the account's own setting: this account carries its
    // directories, so the row starts ticked and the toggle goes the other way.
    expect(card.getSnapshot().dirsEnabled).toBe(true)
    actions.toggle('dirsEnabled', false)
    expect(card.getSnapshot().dirsEnabled).toBe(false)
    expect(card.getSnapshot().dirty).toBe(true)

    repliesInTurn({ ok: true }, { ...status(), ok: true })
    actions.save()
    await vi.waitFor(() => {
      expect(sent.some((entry) => entry.url.includes('/plugin/webdav-sync/config'))).toBe(true)
    })
    const body = sent.find((entry) => entry.url.includes('/plugin/webdav-sync/config'))?.body as {
      dirsEnabled?: boolean
    }
    expect(body.dirsEnabled).toBe(false)
  })

  it('reads a host too old to know the switch as having it off', async () => {
    // A host from before the switch existed has no such flag to send, and the
    // resting state of that part is off: an answer without it must not make the
    // card draw a directory as travelling when nothing says it does.
    const legacy = { ...CONFIG } as Partial<typeof CONFIG>
    delete legacy.dirsEnabled
    const { card } = await ready({ config: legacy as unknown as StatusResult['config'] })
    expect(card.getSnapshot().dirsEnabled).toBe(false)
  })
})

describe('the API keys part', () => {
  it('reads the switch from the configuration and sends it back on save', async () => {
    const { card, actions } = await ready()
    expect(card.getSnapshot().keys).toBe(true)
    actions.toggle('keys', false)
    expect(card.getSnapshot().keys).toBe(false)
    expect(card.getSnapshot().dirty).toBe(true)

    repliesInTurn({ ok: true }, { ...status(), ok: true })
    actions.save()
    await vi.waitFor(() => {
      expect(sent.some((entry) => entry.url.includes('/plugin/webdav-sync/config'))).toBe(true)
    })
    const body = sent.find((entry) => entry.url.includes('/plugin/webdav-sync/config'))?.body as { keys?: boolean }
    expect(body.keys).toBe(false)
  })

  it('reads a host too old to know the part as having it on', async () => {
    // A host from before this part has no keys of its own to send, so drawing the
    // row as off would be the card saying something it was never told.
    const legacy = { ...CONFIG } as Partial<typeof CONFIG>
    delete legacy.keys
    const { card } = await ready({ config: legacy as unknown as StatusResult['config'] })
    expect(card.getSnapshot().keys).toBe(true)
  })

  it('keeps a key it could not write, so the card can say which name it was', async () => {
    const { card, actions } = await ready()
    repliesInTurn(
      { ok: true, reloadNeeded: false, keysProblems: [{ ref: 'OFOX_API_KEY', message: 'the store said no' }] },
      { ...status(), ok: true },
    )
    actions.sync()
    await vi.waitFor(() => {
      expect(card.getSnapshot().busy).toBe('')
    })
    expect(card.getSnapshot().keysProblems).toEqual([{ ref: 'OFOX_API_KEY', message: 'the store said no' }])
  })
})

describe('a failed call', () => {
  it('becomes a message, never an escaping rejection', async () => {
    const { card, actions } = await ready()
    replies({ error: 'the server said no' }, 400)
    actions.save()
    await vi.waitFor(() => {
      expect(card.getSnapshot().busy).toBe('')
    })
    const state = card.getSnapshot()
    expect(state.message).toBe('the server said no')
    expect(state.messageFailed).toBe(true)
  })

  it('shows a transport failure as a message too', async () => {
    const { card, actions } = await ready()
    vi.stubGlobal('fetch', async () => {
      throw new Error('network is down')
    })
    actions.check()
    await vi.waitFor(() => {
      expect(card.getSnapshot().busy).toBe('')
    })
    expect(card.getSnapshot().message).toBe('network is down')
    expect(card.getSnapshot().messageFailed).toBe(true)
  })

  it('leaves a refused save\'s draft exactly as it was typed', async () => {
    const { card, actions } = await ready()
    actions.edit('url', 'https://typed.test/dav')
    actions.edit('user', 'typed-user')
    actions.edit('password', 'typed-password')
    replies({ error: '口令不能和 WebDAV 密码相同' }, 400)
    actions.save()
    await vi.waitFor(() => {
      expect(card.getSnapshot().busy).toBe('')
    })
    const state = card.getSnapshot()
    expect(state.message).toBe('口令不能和 WebDAV 密码相同')
    // The follow-up read never ran, so nothing replaced what was typed: the
    // message is not all that is left of the form.
    expect(state.url).toBe('https://typed.test/dav')
    expect(state.user).toBe('typed-user')
    expect(state.password).toBe('typed-password')
    expect(state.dirty).toBe(true)
    expect(sent.filter((one) => one.url === ROUTE_STATUS)).toHaveLength(1)
  })
})

describe('one action at a time', () => {
  it('ignores a second action while the first is still in flight', async () => {
    const { card, actions } = await ready()
    let release: (() => void) | undefined
    vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
      sent.push({
        url: String(url),
        method: String(init.method ?? 'GET'),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      return new Promise<Response>((resolve) => {
        release = () => resolve(new Response(JSON.stringify({ ok: true, reloadNeeded: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }))
      })
    })
    actions.sync()
    expect(card.getSnapshot().busy).toBe('sync')
    // A prompt's close button is an action too; while the sync is in flight it
    // starts nothing — before, it landed and cleared `busy` under the sync.
    actions.dismissPrompt('pending-install', '[]')
    expect(card.getSnapshot().busy).toBe('sync')
    release?.()
    await vi.waitFor(() => {
      expect(card.getSnapshot().busy).toBe('')
    })
    expect(sent.filter((one) => one.url === ROUTE_SYNC)).toHaveLength(1)
    expect(sent.filter((one) => one.url === ROUTE_DISMISS)).toHaveLength(0)
  })

  it('does not reset a draft being typed while an action ran', async () => {
    const { card, actions } = await ready()
    repliesInTurn(
      { ok: true, reloadNeeded: false },
      { ...status(), ok: true },
    )
    actions.sync()
    // The person keeps typing while the sync runs; the read that follows it
    // must not take that away — the same protection the periodic read has.
    actions.edit('user', 'typed-in-flight')
    await vi.waitFor(() => {
      expect(card.getSnapshot().busy).toBe('')
    })
    const state = card.getSnapshot()
    expect(state.user).toBe('typed-in-flight')
    expect(state.dirty).toBe(true)
  })
})

describe('a picked import file', () => {
  it('refuses one bigger than the host would read, before reading it', async () => {
    const { card, actions } = await ready()
    const huge = new File(['x'], 'huge.prop')
    Object.defineProperty(huge, 'size', { value: 40 * 1024 * 1024 })
    actions.pickFile(huge)
    const state = card.getSnapshot()
    expect(state.importName).toBe('')
    expect(state.importText).toBe('')
    expect(state.messageFailed).toBe(true)
    expect(state.message).toContain('32 MiB')
  })
})

describe('an answered call is not drawn as a failure', () => {
  it('a check the server accepted is not marked failed', async () => {
    const { card, actions } = await ready()
    replies({ ok: true, message: 'the server answered', hasBackup: true })
    actions.check()
    await vi.waitFor(() => {
      expect(card.getSnapshot().busy).toBe('')
    })
    expect(card.getSnapshot().message).toBe('the server answered')
    expect(card.getSnapshot().messageFailed).toBe(false)
  })

  it('a check the host itself refused is marked failed', async () => {
    const { card, actions } = await ready()
    // The route answers 200 with ok:false when the server refuses the sign-in:
    // that is the one case where a 200 still means "this went wrong".
    replies({ ok: false, message: 'the WebDAV server refused the user name', hasBackup: false } satisfies CheckResult)
    actions.check()
    await vi.waitFor(() => {
      expect(card.getSnapshot().busy).toBe('')
    })
    expect(card.getSnapshot().messageFailed).toBe(true)
  })

  it('an install that worked is not marked failed', async () => {
    const { card, actions } = await ready()
    // Installing is followed by a fresh read, and that read is a status: a
    // payload without one would be the host's own doing, not the stub's.
    repliesInTurn(
      { ok: true, output: 'pnpm finished' } satisfies InstallResult,
      { ...status(), ok: true },
    )
    actions.install()
    await vi.waitFor(() => {
      expect(card.getSnapshot().busy).toBe('')
    })
    expect(card.getSnapshot().installOutput).toBe('pnpm finished')
    expect(card.getSnapshot().installFailed).toBe(false)
    expect(card.getSnapshot().messageFailed).toBe(false)
  })

  it('an install that did not work is marked failed', async () => {
    const { card, actions } = await ready()
    repliesInTurn(
      { ok: false, output: 'pnpm finished, but these are still not installed: x' } satisfies InstallResult,
      { ...status(), ok: true },
    )
    actions.install()
    await vi.waitFor(() => {
      expect(card.getSnapshot().busy).toBe('')
    })
    expect(card.getSnapshot().installOutput).toContain('still not installed')
    expect(card.getSnapshot().installFailed).toBe(true)
  })

  it('closes the install report without touching anything else', async () => {
    const { card, actions } = await ready()
    repliesInTurn(
      { ok: false, output: 'pnpm finished, but these are still not installed: x' } satisfies InstallResult,
      { ...status(), ok: true },
    )
    actions.install()
    await vi.waitFor(() => {
      expect(card.getSnapshot().installOutput).not.toBe('')
    })
    sent = []
    actions.closeOutput()
    // Local: no route, no read, nothing else in the snapshot moves.
    expect(sent).toEqual([])
    expect(card.getSnapshot().installOutput).toBe('')
    expect(card.getSnapshot().installFailed).toBe(false)
    expect(card.getSnapshot().view).not.toBeUndefined()
    expect(card.getSnapshot().dirty).toBe(false)
  })

  it('keeps the report readable after a later failure from something else', async () => {
    const { card, actions } = await ready()
    repliesInTurn(
      { ok: true, output: 'pnpm finished' } satisfies InstallResult,
      { ...status(), ok: true },
    )
    actions.install()
    await vi.waitFor(() => {
      expect(card.getSnapshot().installOutput).toBe('pnpm finished')
    })
    // A check the host refused afterwards is a failure of *that* call; the log
    // above it still says the install worked, so the two must not share a flag.
    replies({ ok: false, message: 'the WebDAV server refused the user name', hasBackup: false } satisfies CheckResult)
    actions.check()
    await vi.waitFor(() => {
      expect(card.getSnapshot().busy).toBe('')
    })
    expect(card.getSnapshot().messageFailed).toBe(true)
    expect(card.getSnapshot().installFailed).toBe(false)
  })
})

describe('taking a prompt down by hand', () => {
  it('every prompt a card state can hold has a close that answers it', async () => {
    const { card, actions } = await ready({
      error: 'the computer is asleep',
      dirProblems: [{ path: '/data', message: 'not there' }],
      keysProblems: [{ ref: 'K', message: 'no store' }],
      pendingInstall: true,
      pendingNames: ['some-plugin'],
    })
    repliesInTurn({ ok: true, changes: [{ part: 'models', take: 'remote' }] }, { ...status(), ok: true })
    actions.preview()
    await vi.waitFor(() => {
      expect(card.getSnapshot().preview).toBeDefined()
    })

    // The message line is also the failed-refresh line's state: one field, both
    // written by a failed read and by a failed call, and one clear answers both.
    actions.closeMessage()
    expect(card.getSnapshot().error).toBe('')
    expect(card.getSnapshot().preview).toBeDefined()

    actions.closePreview()
    expect(card.getSnapshot().preview).toBeUndefined()

    actions.closeKeyProblems()
    expect(card.getSnapshot().keysProblems).toEqual([])

    // The reload note rides the sync that set it; closing it is local and does
    // not touch what the view holds. The sync's follow-up read is the plain
    // fixture (no pendingInstall), so the view now says the same: the assertion
    // here is only that the close moved the local flag, not the view's data.
    repliesInTurn({ ok: true, here: ['patch'], there: [], pushed: true, reloadNeeded: true, pendingInstall: false }, { ...status(), ok: true })
    actions.sync()
    await vi.waitFor(() => {
      expect(card.getSnapshot().reloadNeeded).toBe(true)
    })
    actions.closeReload()
    expect(card.getSnapshot().reloadNeeded).toBe(false)
    expect(card.getSnapshot().view?.pendingInstall).toBe(false)
  })

  it('closes the export and import reports locally', async () => {
    const { card, actions } = await ready()
    replies({
      ok: true,
      file: '/home/me/setup.prop',
      size: 12,
      parts: ['models'],
    })
    actions.openExport()
    actions.editExport('passphrase', 'Quiet Larch 7')
    actions.runExport()
    await vi.waitFor(() => {
      expect(card.getSnapshot().exported).toBeDefined()
    })
    actions.closeExportReport()
    expect(card.getSnapshot().exported).toBeUndefined()

    replies({ ok: true, here: ['models'], same: [], reloadNeeded: false, pendingInstall: false, created: 'x' })
    actions.openImport()
    actions.editImport('passphrase', 'Quiet Larch 7')
    card.pickFile(new File(['{}'], 'setup.prop'))
    await vi.waitFor(() => {
      expect(card.getSnapshot().importText).not.toBe('')
    })
    actions.runImport()
    await vi.waitFor(() => {
      expect(card.getSnapshot().imported).toBeDefined()
    })
    actions.closeImportReport()
    expect(card.getSnapshot().imported).toBeUndefined()
  })

  it('a host-held prompt is put away by target and the payload signature', async () => {
    const { card, actions } = await ready({ pendingInstall: true, pendingNames: ['alpha', 'beta'] })
    sent = []
    repliesInTurn({ message: '已关闭提示' }, { ...status(), ok: true })
    actions.dismissPrompt('pending-install', '["alpha","beta"]')
    await vi.waitFor(() => {
      expect(sent.length).toBeGreaterThan(0)
    })
    expect(sent[0]?.url).toContain('/plugin/webdav-sync/dismiss')
    expect(sent[0]?.body).toEqual({ target: 'pending-install', signature: '["alpha","beta"]' })
  })

  it('a dir-problems dismissal carries the list it is dismissing', async () => {
    const { actions } = await ready({ dirProblems: [{ path: '/data', message: 'gone' }] })
    sent = []
    repliesInTurn({ message: '已关闭提示' }, { ...status(), ok: true })
    actions.dismissPrompt('dir-problems', '[{"path":"/data","message":"gone"}]')
    await vi.waitFor(() => {
      expect(sent.length).toBeGreaterThan(0)
    })
    expect(sent[0]?.body).toEqual({ target: 'dir-problems', signature: '[{"path":"/data","message":"gone"}]' })
  })

  it('the signature helper is stable and order-faithful', () => {
    expect(signatureOf([])).toBe('[]')
    expect(signatureOf(['alpha', 'beta'])).toBe('["alpha","beta"]')
    expect(signatureOf(['beta', 'alpha'])).not.toBe(signatureOf(['alpha', 'beta']))
  })
})

describe('what a sync sends and keeps', () => {
  it('forces through the unchanged-server early return', async () => {
    const { card, actions } = await ready()
    sent = []
    repliesInTurn({ ok: true, here: [], there: [], pushed: true, reloadNeeded: false, pendingInstall: false }, { ...status(), ok: true })
    actions.sync()
    await vi.waitFor(() => {
      expect(sent.length).toBeGreaterThan(0)
    })
    expect(sent[0]?.url).toContain('/plugin/webdav-sync/sync')
    expect(sent[0]?.body).toEqual({ force: true })
  })

  it('remembers that a merge left files to reload', async () => {
    const { card, actions } = await ready()
    repliesInTurn({ ok: true, here: ['patch'], there: [], pushed: true, reloadNeeded: true, pendingInstall: false }, { ...status(), ok: true })
    actions.sync()
    await vi.waitFor(() => {
      expect(card.getSnapshot().busy).toBe('')
    })
    expect(card.getSnapshot().reloadNeeded).toBe(true)
  })

  it('clears the previous preview once it has synced', async () => {
    const { card, actions } = await ready()
    repliesInTurn({ ok: true, changes: [{ part: 'models', take: 'remote' }] }, { ...status(), ok: true })
    actions.preview()
    await vi.waitFor(() => {
      expect(card.getSnapshot().preview).toBeDefined()
    })
    expect(card.getSnapshot().preview?.changes).toHaveLength(1)

    repliesInTurn({ ok: true, here: [], there: [], pushed: true, reloadNeeded: false, pendingInstall: false }, { ...status(), ok: true })
    actions.sync()
    await vi.waitFor(() => {
      expect(card.getSnapshot().preview).toBeUndefined()
    })
  })
})

describe('confirmations', () => {
  it('does nothing until the question is answered', async () => {
    const { card, actions } = await ready()
    actions.askRestore()
    expect(card.getSnapshot().confirm).toBe('restore')
    expect(sent).toHaveLength(1) // only the status read

    actions.answer(false)
    expect(card.getSnapshot().confirm).toBe('')
    expect(sent).toHaveLength(1)
  })

  it('runs the destructive action once confirmed', async () => {
    const { card, actions } = await ready()
    actions.askOff()
    repliesInTurn({ ok: true, message: 'WebDAV sync is off; the file on the server stays' }, { ...status({ configured: false }), ok: true })
    actions.answer(true)
    await vi.waitFor(() => {
      expect(card.getSnapshot().confirm).toBe('')
      expect(sent.length).toBeGreaterThan(1)
    })
    expect(sent[1]?.url).toContain('/plugin/webdav-sync/off')
  })

  it('asks nothing for restore when the answer is no', async () => {
    const { card, actions } = await ready()
    actions.askUpload()
    actions.answer(false)
    expect(sent).toHaveLength(1)
    expect(card.getSnapshot().confirm).toBe('')
  })
})

describe('every action goes to its own route', () => {
  const route = (name: string): string => `/plugin/webdav-sync/${name}`

  it('sends each action to the route named for it', async () => {
    const cases: { method: keyof ReturnType<WebdavSyncCard['actions']>; path: string }[] = [
      { method: 'save', path: route('config') },
      { method: 'check', path: route('check') },
      { method: 'preview', path: route('preview') },
      { method: 'sync', path: route('sync') },
      { method: 'undo', path: route('undo') },
      { method: 'install', path: route('install') },
      { method: 'dismiss', path: route('dismiss') },
    ]
    for (const one of cases) {
      sent = []
      const { actions } = await ready()
      sent = []
      repliesInTurn({ ok: true, message: 'fine', output: '', reloadNeeded: false, pushed: true, here: [], there: [], changes: [] }, { ...status(), ok: true })
      const action = actions[one.method] as () => void
      action()
      await vi.waitFor(() => {
        expect(sent.length).toBeGreaterThan(0)
      })
      expect(sent[0]?.url).toContain(one.path)
    }
  })
})

describe('the snapshot React reads', () => {
  it('is the same object until something changes', async () => {
    const { card } = await ready()
    const first = card.getSnapshot()
    expect(card.getSnapshot()).toBe(first)
    card.edit('url', 'https://other.test/dav')
    const second: CardState = card.getSnapshot()
    expect(second).not.toBe(first)
  })

  it('unsubscribes cleanly', async () => {
    const { card } = await ready()
    let calls = 0
    const stop = card.subscribe(() => {
      calls += 1
    })
    card.edit('url', 'https://a.test')
    stop()
    card.edit('url', 'https://b.test')
    expect(calls).toBe(1)
  })
})
