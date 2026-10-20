/**
 * The relay section's store.
 *
 * The relay's card is a second set of inputs in the same panel as the sync's,
 * and the two things worth pinning are that it never writes while a field it
 * itself refuses is still wrong, and that a refused write becomes a sentence
 * rather than an escaping rejection — the same contract `card-store` keeps.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebdavRelayCard } from '../src/client/relay-store.ts'
import type { RelayStatusResult } from '../src/wire.ts'

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

/** A host answer for the relay status route. */
function view(over: Partial<RelayStatusResult> = {}): RelayStatusResult {
  return {
    config: { enabled: true, port: 3426, token: 'a'.repeat(32), target: 'https://dav.test/dav', headers: '' },
    url: `http://127.0.0.1:3426/${'a'.repeat(32)}`,
    listening: true,
    error: '',
    file: '/p/.dsh-webdav-relay/relay.json',
    ...over,
  }
}

/** A card that has read one status, ready to act. */
async function ready(over: Partial<RelayStatusResult> = {}): Promise<WebdavRelayCard> {
  replies(view(over))
  const card = new WebdavRelayCard()
  await card.load()
  return card
}

beforeEach(() => {
  sent = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('reading the relay status', () => {
  it('seeds the draft and leaves it clean', async () => {
    const card = await ready()
    const state = card.getSnapshot()
    expect(state.phase).toBe('ready')
    expect(state.enabled).toBe(true)
    expect(state.target).toBe('https://dav.test/dav')
    expect(state.port).toBe('3426')
    expect(state.dirty).toBe(false)
    expect(state.view?.url).toBe(`http://127.0.0.1:3426/${'a'.repeat(32)}`)
  })

  it('keeps the host’s complaint as the error', async () => {
    replies({ error: '转发端口 3426 用不了' }, 500)
    const card = new WebdavRelayCard()
    await card.load()
    expect(card.getSnapshot().error).toMatch(/端口/)
    expect(card.getSnapshot().view).toBeUndefined()
  })

  it('draws nothing while the first read is in flight', () => {
    const card = new WebdavRelayCard()
    expect(card.getSnapshot().phase).toBe('loading')
    expect(card.getSnapshot().view).toBeUndefined()
  })
})

describe('writing the relay status', () => {
  it('sends the whole draft on save', async () => {
    const card = await ready()
    replies(view({ config: { ...view().config, target: 'https://dav.test/other' } }))
    card.edit('target', 'https://dav.test/other')
    card.save()
    await vi.waitFor(() => expect(card.getSnapshot().dirty).toBe(false))
    const write = sent[sent.length - 1]!
    expect(write.method).toBe('POST')
    expect(write.body).toEqual({
      enabled: true,
      target: 'https://dav.test/other',
      headers: '',
      port: 3426,
    })
    expect(card.getSnapshot().dirty).toBe(false)
  })

  it('refuses a port that is not one, and writes nothing', async () => {
    const card = await ready()
    sent = []
    card.edit('port', 'not a port')
    card.save()
    // Nothing was sent: the card is the one that knows the field is a port.
    expect(sent).toHaveLength(0)
    expect(card.getSnapshot().problem).toBe('relayPortBad')
    expect(card.getSnapshot().busy).toBe('')
  })

  it('refuses a port out of range', async () => {
    const card = await ready()
    sent = []
    card.edit('port', '70000')
    card.save()
    expect(sent).toHaveLength(0)
    expect(card.getSnapshot().problem).toBe('relayPortBad')
  })

  it('clears the port complaint once the field is touched again', async () => {
    const card = await ready()
    card.edit('port', 'nope')
    card.save()
    expect(card.getSnapshot().problem).toBe('relayPortBad')
    card.edit('port', '3427')
    expect(card.getSnapshot().problem).toBe('')
  })

  it('turns a refused write into a message', async () => {
    const card = await ready()
    replies({ error: '转发目标还没填' }, 500)
    card.edit('target', '')
    card.save()
    await vi.waitFor(() => expect(card.getSnapshot().message).toMatch(/转发目标/))
    expect(card.getSnapshot().messageFailed).toBe(true)
    expect(card.getSnapshot().busy).toBe('')
  })

  it('asks the host for a new address without carrying the draft', async () => {
    const card = await ready()
    sent = []
    replies(view({ config: { ...view().config, token: 'b'.repeat(32) } }))
    card.edit('target', 'https://half-typed')
    card.regenerate()
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]!.body).toEqual({ token: '' })
  })

  it('puts the draft back without writing anything', async () => {
    const card = await ready()
    sent = []
    card.edit('target', 'https://dav.test/other')
    card.toggle(false)
    expect(card.getSnapshot().dirty).toBe(true)
    card.reset()
    expect(card.getSnapshot().dirty).toBe(false)
    expect(card.getSnapshot().target).toBe('https://dav.test/dav')
    expect(card.getSnapshot().enabled).toBe(true)
    expect(sent).toHaveLength(0)
  })

  it('reads the status once, however often ensure is called', async () => {
    replies(view())
    const card = new WebdavRelayCard()
    card.ensure()
    card.ensure()
    card.ensure()
    await vi.waitFor(() => expect(card.getSnapshot().phase).toBe('ready'))
    expect(sent).toHaveLength(1)
  })
})
