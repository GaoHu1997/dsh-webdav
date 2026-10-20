/**
 * The relay section's state and its writes.
 *
 * Deliberately a store of its own, not a corner of the sync card's: the relay is
 * a separate feature with a separate file, a separate route pair and a separate
 * Save. Sharing the sync card's draft would mean one Save button writing two
 * unrelated configurations, and a failure in one would look like a failure in
 * the other.
 *
 * The shape follows `card-store.ts`: a server view that only ever comes from the
 * host half's routes, a draft that is what the inputs hold until Save, and every
 * refusal folded into a message rather than left as a rejection.
 */

import type { Call } from './api.ts'
import { requestRelayConfig, requestRelayStatus } from './api.ts'
import { RELAY_DEFAULT_PORT, type RelayBody, type RelayStatusResult } from '../wire.ts'

/** One immutable relay snapshot. */
export interface RelayState {
  /** Whether the relay status has been read yet. */
  phase: 'loading' | 'ready'
  /** What the last read or write said went wrong; '' when fine. */
  error: string
  /** The last status the host gave, or undefined before the first read. */
  view: RelayStatusResult | undefined

  // ---- the draft ----
  /** Whether the forwarder should be listening. */
  enabled: boolean
  /** The real WebDAV base address, as typed. */
  target: string
  /** Extra request headers, as typed: one `Name: value` per line. */
  headers: string
  /**
   * The port as typed. A string because that is what an input holds; the host is
   * the one that says whether it is a port at all.
   */
  port: string
  /** Whether the draft differs from what the host last reported. */
  dirty: boolean

  // ---- transient ----
  busy: '' | 'save'
  /** The last write's outcome. */
  message: string
  /** Whether `message` is a failure. */
  messageFailed: boolean
  /**
   * A draft field the card itself refuses, kept as a key rather than as a
   * sentence: the card is translated, the store is not.
   */
  problem: '' | 'relayPortBad'
}

/** What the relay section can ask the host to do. */
export interface RelayActions {
  /** Read the relay status once, if it has not been read. */
  ensure(): void
  /** Re-read the status, discarding the draft. */
  refresh(): void
  /** Stage one text field. */
  edit(field: RelayDraftField, value: string): void
  /** Flip the switch. */
  toggle(enabled: boolean): void
  /** Put the draft back to what the host last reported. */
  reset(): void
  /** Write the draft and rebuild the forwarder. */
  save(): void
  /**
   * Mint a new address. The client has to be pointed at the relay again
   * afterwards, so this is its own action rather than a side effect of Save.
   */
  regenerate(): void
}

/** The relay draft's text fields. */
export type RelayDraftField = 'target' | 'headers' | 'port'

/** An observable relay state source: `getSnapshot` is stable between changes. */
export interface RelayStore {
  getSnapshot(): RelayState
  subscribe(listener: () => void): () => void
}

const EMPTY: RelayState = {
  phase: 'loading',
  error: '',
  view: undefined,
  enabled: false,
  target: '',
  headers: '',
  port: String(RELAY_DEFAULT_PORT),
  dirty: false,
  busy: '',
  message: '',
  messageFailed: false,
  problem: '',
}

/** The relay section: an observable snapshot, the staged draft, and the write. */
export class WebdavRelayCard implements RelayStore, RelayActions {
  private state: RelayState = EMPTY
  private readonly listeners = new Set<() => void>()
  private started = false

  getSnapshot(): RelayState {
    return this.state
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Replace the state only on a real change, so React skips no-op renders. */
  private set(patch: Partial<RelayState>): void {
    const next = { ...this.state, ...patch }
    let moved = false
    for (const key of Object.keys(next) as (keyof RelayState)[]) {
      if (next[key] !== this.state[key]) {
        moved = true
        break
      }
    }
    if (!moved) return
    this.state = next
    for (const listener of [...this.listeners]) listener()
  }

  /** Seed the draft from a status the host just gave. */
  private adopt(view: RelayStatusResult): void {
    this.set({
      phase: 'ready',
      view,
      enabled: view.config.enabled,
      target: view.config.target,
      headers: view.config.headers,
      port: String(view.config.port),
      dirty: false,
    })
  }

  ensure(): void {
    if (this.started) return
    this.started = true
    void this.load()
  }

  async load(): Promise<void> {
    this.set({ phase: this.state.view === undefined ? 'loading' : this.state.phase, error: '' })
    const answer = await requestRelayStatus()
    if (!answer.ok) {
      this.set({ phase: 'ready', error: answer.error, view: undefined })
      return
    }
    this.adopt(answer.data)
  }

  refresh(): void {
    void this.load()
  }

  edit(field: RelayDraftField, value: string): void {
    this.set({ [field]: value, dirty: true, problem: '' } as Partial<RelayState>)
  }

  toggle(enabled: boolean): void {
    this.set({ enabled, dirty: true })
  }

  reset(): void {
    const view = this.state.view
    if (view === undefined) return
    this.adopt(view)
    this.set({ message: '', messageFailed: false, problem: '' })
  }

  save(): void {
    const port = Number(this.state.port.trim())
    // The host checks this too, but only once it has been handed a number: a
    // field that is not one has to be refused here, or it would be sent as
    // nothing and the stored port would quietly stay what it was.
    const usable = Number.isInteger(port) && port > 0 && port <= 65_535
    this.set({ problem: usable ? '' : 'relayPortBad' })
    if (!usable) return
    void this.write({
      enabled: this.state.enabled,
      target: this.state.target,
      headers: this.state.headers,
      port,
    })
  }

  regenerate(): void {
    // The token alone: every other field is left as stored, so asking for a new
    // address never carries a half-typed draft along with it.
    void this.write({ token: '' })
  }

  private async write(body: RelayBody): Promise<void> {
    this.set({ busy: 'save', message: '', messageFailed: false, problem: '' })
    const answer: Call<RelayStatusResult> = await requestRelayConfig(body)
    if (!answer.ok) {
      this.set({ busy: '', message: answer.error, messageFailed: true })
      return
    }
    this.set({ busy: '' })
    this.adopt(answer.data)
  }

  /** Every action as plain methods, for the inject face and for tests. */
  actions(): RelayActions {
    return {
      ensure: () => this.ensure(),
      refresh: () => this.refresh(),
      edit: (field, value) => this.edit(field, value),
      toggle: (enabled) => this.toggle(enabled),
      reset: () => this.reset(),
      save: () => this.save(),
      regenerate: () => this.regenerate(),
    }
  }
}
