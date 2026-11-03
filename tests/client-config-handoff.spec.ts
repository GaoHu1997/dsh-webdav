import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WebdavSyncCard } from '../src/client/card-store.ts'
import { APPLIED_EVENT, BEFORE_SNAPSHOT_EVENT } from '../src/client/config-handoff.ts'
import { ROUTE_SYNC } from '../src/wire.ts'

beforeEach(() => { vi.stubGlobal('window', new EventTarget()) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('times out a hanging handoff without starting sync', async () => {
  vi.useFakeTimers()
  window.addEventListener(BEFORE_SNAPSHOT_EVENT, event => {
    (event as CustomEvent<{ waitUntil: (task: Promise<void>) => void }>).detail.waitUntil(new Promise<void>(() => {}))
  })
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  const card = new WebdavSyncCard()
  card.actions().sync()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(card.getSnapshot().busy).toBe('')
  expect(card.getSnapshot().message).toBe('模型配置保存超时，请重试同步')
  expect(card.getSnapshot().messageFailed).toBe(true)
  expect(fetcher).not.toHaveBeenCalled()
})

it('waits for browser configuration to land before sync, then announces the apply', async () => {
  let finish!: () => void
  const landing = new Promise<void>(resolve => { finish = resolve })
  const before = (event: Event) => {
    (event as CustomEvent<{ waitUntil: (task: Promise<void>) => void }>).detail.waitUntil(landing)
  }
  const applied = vi.fn()
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true })))
  vi.stubGlobal('fetch', fetcher)
  window.addEventListener(BEFORE_SNAPSHOT_EVENT, before)
  window.addEventListener(APPLIED_EVENT, applied)
  try {
    const card = new WebdavSyncCard()
    card.actions().sync()
    await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()
    expect(card.getSnapshot().busy).toBe('sync')
    finish()
    await vi.waitFor(() => expect(applied).toHaveBeenCalledOnce())
    expect(fetcher.mock.calls[0]?.[0]).toBe(ROUTE_SYNC)
  } finally {
    window.removeEventListener(BEFORE_SNAPSHOT_EVENT, before)
    window.removeEventListener(APPLIED_EVENT, applied)
  }
})

it('does not sync or announce success when browser configuration failed to save', async () => {
  const before = (event: Event) => {
    (event as CustomEvent<{ waitUntil: (task: Promise<void>) => void }>).detail.waitUntil(Promise.reject(new Error('save failed')))
  }
  const applied = vi.fn()
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  window.addEventListener(BEFORE_SNAPSHOT_EVENT, before)
  window.addEventListener(APPLIED_EVENT, applied)
  try {
    const card = new WebdavSyncCard()
    card.actions().sync()
    await vi.waitFor(() => expect(card.getSnapshot().message).toBe('save failed'))
    expect(card.getSnapshot().busy).toBe('')
    expect(card.getSnapshot().messageFailed).toBe(true)
    expect(fetcher).not.toHaveBeenCalled()
    expect(applied).not.toHaveBeenCalled()
  } finally {
    window.removeEventListener(BEFORE_SNAPSHOT_EVENT, before)
    window.removeEventListener(APPLIED_EVENT, applied)
  }
})

it('does not announce an apply for a refused sync', async () => {
  const applied = vi.fn()
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'refused' }), { status: 500 }))
  window.addEventListener(APPLIED_EVENT, applied)
  try {
    const card = new WebdavSyncCard()
    card.actions().sync()
    await vi.waitFor(() => expect(card.getSnapshot().messageFailed).toBe(true))
    expect(applied).not.toHaveBeenCalled()
  } finally { window.removeEventListener(APPLIED_EVENT, applied) }
})
