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
import { WebdavSyncCard } from '../src/client/card-store.ts'
import type { CardState } from '../src/client/card-store.ts'
import type { CheckResult, InstallResult, StatusResult } from '../src/wire.ts'

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

const CONFIG = {
  url: 'https://dav.test/dav',
  user: 'me',
  passwordSet: true,
  passphraseSet: true,
  autoEvery: -1,
  models: true,
  defaults: true,
  plugins: true,
  patch: true,
  dirs: [],
  rememberPassword: true,
  headers: '',
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
async function ready(over: Partial<StatusResult> = {}): Promise<{ card: WebdavSyncCard; actions: ReturnType<WebdavSyncCard['actions']> }> {
  replies({ ...status(over), ok: true })
  const card = new WebdavSyncCard()
  await card.load()
  return { card, actions: card.actions() }
}

beforeEach(() => {
  sent = []
})

afterEach(() => {
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
    expect(card.getSnapshot().messageFailed).toBe(true)
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
