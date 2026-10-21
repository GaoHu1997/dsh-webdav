import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchStatus } from '../src/client/status-polling.ts'

let page: EventTarget & { visibilityState: string }
let browser: EventTarget
let stop: (() => void) | undefined

beforeEach(() => {
  vi.useFakeTimers()
  page = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  browser = new EventTarget()
  vi.stubGlobal('document', page)
  vi.stubGlobal('window', browser)
})

afterEach(() => {
  stop?.()
  stop = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('status polling lifecycle', () => {
  it('reads on entry and every 15 seconds while the card stays open', () => {
    const poll = vi.fn()
    stop = watchStatus(poll)
    expect(poll).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(14_999)
    expect(poll).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(poll).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(3 * 60_000)
    expect(poll).toHaveBeenCalledTimes(14)
  })

  it('catches up immediately after hiding, window focus, and reconnecting', () => {
    const poll = vi.fn()
    stop = watchStatus(poll)
    page.visibilityState = 'hidden'
    page.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(10 * 60_000)
    expect(poll).toHaveBeenCalledTimes(1)
    page.visibilityState = 'visible'
    page.dispatchEvent(new Event('visibilitychange'))
    expect(poll).toHaveBeenCalledTimes(2)
    browser.dispatchEvent(new Event('focus'))
    expect(poll).toHaveBeenCalledTimes(3)
    browser.dispatchEvent(new Event('online'))
    expect(poll).toHaveBeenCalledTimes(4)
  })

  it('removes every listener and timer, then refreshes on remount', () => {
    const poll = vi.fn()
    stop = watchStatus(poll)
    stop()
    vi.advanceTimersByTime(60_000)
    for (const name of ['focus', 'online']) browser.dispatchEvent(new Event(name))
    page.dispatchEvent(new Event('visibilitychange'))
    expect(poll).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    stop = watchStatus(poll)
    expect(poll).toHaveBeenCalledTimes(2)
  })
})
