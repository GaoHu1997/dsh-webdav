/**
 * The card's state and its writes.
 *
 * Two things live here and they are deliberately separate:
 *
 * - the *server* view (`StatusResult`), which only ever comes from the host
 *   half's routes — the browser half knows nothing about profiles or WebDAV;
 * - the *draft*, which is what the form's inputs hold until Save.
 *
 * Upstream secrets are never read back: the config view carries `passwordSet` /
 * `passphraseSet` booleans only, so a blank input means "leave the stored one
 * alone" (`ConfigureBody`'s contract) and is not the same as clearing it. The
 * relay's local account is in the separate status view for copying, never in
 * the editable draft or the configure body.
 *
 * A write that the host refuses is caught here and turned into a message, never
 * allowed to escape: a control's `onChange` discards its promise, so an
 * escaping rejection would be unhandled while the control silently snapped
 * back to the old value.
 */

import type { Call } from './api.ts'
import {
  requestCheck,
  requestConfigure,
  requestDismiss,
  requestInstall,
  requestOff,
  requestPreview,
  requestRestore,
  requestStatus,
  requestSync,
  requestUndo,
  requestUpload,
} from './api.ts'
import type { DirectoryChooser } from './picker.ts'
import { AUTO_CHOICES, AUTO_MANUAL, DIRS_MAX, RELAY_DEFAULT_PORT, type ConfigureBody, type PreviewResult, type StatusResult } from '../wire.ts'

/** Which of the four big actions is in flight, for the button that shows it. */
export type CardBusy = '' | 'save' | 'check' | 'preview' | 'sync' | 'restore' | 'undo' | 'upload' | 'install' | 'off' | 'dismiss'

/** A confirmation the card is waiting on before doing something destructive. */
export type CardConfirm = '' | 'restore' | 'upload' | 'off'

/** One immutable card snapshot. */
export interface CardState {
  /** Whether the status has been read yet. */
  phase: 'loading' | 'ready'
  /** What the last status read or action said went wrong; '' when fine. */
  error: string
  /** The last status the host gave, or undefined before the first read. */
  view: StatusResult | undefined

  // ---- the draft (what the inputs hold) ----
  url: string
  user: string
  password: string
  passphrase: string
  /** Extra request headers as typed: one `Name: value` per line. */
  headers: string
  /**
   * The extra directories to sync, in the order the rows are shown.
   *
   * A row can be blank — that is what a freshly added one holds — and it is the
   * host that trims the list down when the draft is saved: what comes back from
   * the next status read is the stored list, so a blank row disappears at the
   * first save rather than being refused at it.
   */
  dirs: string[]
  /**
   * Whether this computer carries the extra directories at all.
   *
   * Off keeps the list above — the paths stay on screen — and stops this computer
   * from reading or writing them. Nothing is deleted for anybody else.
   */
  dirsEnabled: boolean
  rememberPassword: boolean
  autoEvery: number
  models: boolean
  defaults: boolean
  plugins: boolean
  patch: boolean
  /**
   * Whether other programs on this computer may come in through this plugin.
   *
   * Off leaves the account below alone, so turning it back on does not hand the
   * programs that hold it a new one.
   */
  relayEnabled: boolean
  /** The loopback port those programs are told to come to. */
  relayPort: number
  /** Whether the draft differs from what the host last reported. */
  dirty: boolean

  // ---- transient ----
  busy: CardBusy
  /** The last action's outcome, e.g. 'the server answered and holds no backup of yours yet'. */
  message: string
  /** Whether `message` is a failure. */
  messageFailed: boolean
  /** What a preview said, once asked. */
  preview: PreviewResult | undefined
  /** The tail of pnpm's log, once an install ran. */
  installOutput: string
  /** Whether an applied merge left configuration files changed on disk. */
  reloadNeeded: boolean
  /** The confirmation the card is holding, if any. */
  confirm: CardConfirm
}

/** What the card can ask the host to do. */
export interface CardActions {
  /** Read the status once, if it has not been read. */
  ensure(): void
  /** Re-read the status, discarding the draft. */
  refresh(): void
  /**
   * Re-read the status without disturbing the draft, meant for a timer: the
   * person did not ask, so nothing they typed may be taken away.
   */
  poll(): void
  /** Stage one field. */
  edit(field: DraftField, value: string): void
  /** Flip one switch. */
  toggle(field: ToggleField, value: boolean): void
  /** Ask for a directory and stage it. */
  pickDir(): void
  /** Stage one extra-directory row (a row left blank is typed into). */
  editDir(index: number, path: string): void
  /** Take one extra-directory row out of the list. */
  removeDir(index: number): void
  /** Pick an auto-sync interval. */
  setAuto(minutes: number): void
  /**
   * Move the forwarded port up by one, for a port that is already taken.
   *
   * One at a time rather than a field to type in: the number only exists to be
   * pasted into another program, and the address below updates with it, so there
   * is nothing to be gained by letting a half-typed port exist in between.
   */
  nextPort(): void
  /** Stage nothing: put the draft back to what the host last reported. */
  reset(): void
  /** Write the draft. */
  save(): void
  /** Reach the server and say what is there. */
  check(): void
  /** Say what a sync would do. */
  preview(): void
  /** Ask to sync (forces through an unchanged-server early return). */
  sync(): void
  /** Ask for a restore, which needs confirming first. */
  askRestore(): void
  /** Put back what the last restore replaced. */
  undo(): void
  /** Ask for an upload over a file that is not ours, which needs confirming first. */
  askUpload(): void
  /** Ask to stop syncing, which needs confirming first. */
  askOff(): void
  /** Answer the pending confirmation. */
  answer(yes: boolean): void
  /** Fetch the plugins the profile now declares. */
  install(): void
  /** Put the last notice away. */
  dismiss(): void
}

/** The draft's text fields. */
export type DraftField = 'url' | 'user' | 'password' | 'passphrase' | 'headers'
/** The draft's switches. */
export type ToggleField = 'rememberPassword' | 'models' | 'defaults' | 'plugins' | 'patch' | 'dirsEnabled' | 'relayEnabled'

/** An observable card state source: `getSnapshot` is stable between changes. */
export interface CardStore {
  getSnapshot(): CardState
  subscribe(listener: () => void): () => void
}

const EMPTY: CardState = {
  phase: 'loading',
  error: '',
  view: undefined,
  url: '',
  user: '',
  password: '',
  passphrase: '',
  headers: '',
  dirs: [],
  dirsEnabled: true,
  rememberPassword: true,
  autoEvery: AUTO_MANUAL,
  models: true,
  defaults: true,
  plugins: true,
  patch: true,
  relayEnabled: false,
  relayPort: RELAY_DEFAULT_PORT,
  dirty: false,
  busy: '',
  message: '',
  messageFailed: false,
  preview: undefined,
  installOutput: '',
  reloadNeeded: false,
  confirm: '',
}

/** The card: an observable snapshot, the staged draft, and every write. */
export class WebdavSyncCard implements CardStore, CardActions {
  private state: CardState = EMPTY
  private readonly listeners = new Set<() => void>()
  private started = false

  /** The directory dialog of this deployment, when it has one. */
  private readonly choose: DirectoryChooser | undefined

  /**
   * @param choose - how this deployment picks a directory. Left out, the card
   *   still works: a pick then leaves a blank row the path is typed into, which
   *   is also what a deployment with no reachable dialog gets.
   */
  constructor(choose?: DirectoryChooser) {
    this.choose = choose
  }

  getSnapshot(): CardState {
    return this.state
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Replace the state only on a real change, so React skips no-op renders. */
  private set(patch: Partial<CardState>): void {
    const next = { ...this.state, ...patch }
    let moved = false
    for (const key of Object.keys(next) as (keyof CardState)[]) {
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
  private adopt(view: StatusResult): void {
    this.set({
      phase: 'ready',
      view,
      url: view.config.url,
      user: view.config.user,
      // A secret is never sent back, so the draft starts blank: writing blank
      // is what "leave the stored one alone" means.
      password: '',
      passphrase: '',
      headers: view.config.headers,
      // A host from before this part existed answers without it. The list is
      // blank rather than a crash: the card then shows the button and no rows,
      // and saving is what tells the user the host is too old to keep any.
      dirs: [...(view.config.dirs ?? [])],
      // A host from before this switch existed answers without it. The part was
      // on there, so an absent flag reads as on — which is also what a host too
      // old to keep directories at all would have written.
      dirsEnabled: view.config.dirsEnabled ?? true,
      rememberPassword: view.config.rememberPassword,
      autoEvery: view.config.autoEvery,
      models: view.config.models,
      defaults: view.config.defaults,
      plugins: view.config.plugins,
      patch: view.config.patch,
      // A host from before the forwarder existed answers without these: off and
      // the default port, which is what such a host is doing.
      relayEnabled: view.config.relayEnabled ?? false,
      relayPort: view.config.relayPort ?? RELAY_DEFAULT_PORT,
      dirty: false,
    })
  }

  /** Run one call and fold its outcome into the state. */
  private async run(kind: CardBusy, call: () => Promise<Call<unknown>>, describe: (result: unknown) => Partial<CardState>): Promise<void> {
    this.set({ busy: kind, message: '', messageFailed: false })
    const answer = await call()
    if (!answer.ok) {
      this.set({ busy: '', message: answer.error, messageFailed: true })
      return
    }
    this.set({ busy: '', ...describe(answer.data) })
  }

  ensure(): void {
    if (this.started) return
    this.started = true
    void this.load()
  }

  async load(): Promise<void> {
    this.set({ phase: this.state.view === undefined ? 'loading' : this.state.phase, error: '' })
    const answer = await requestStatus()
    if (!answer.ok) {
      this.set({ phase: 'ready', error: answer.error, view: undefined })
      return
    }
    this.adopt(answer.data)
  }

  refresh(): void {
    void this.load()
  }

  /**
   * A read the person did not ask for, for a timer. A first read already in
   * flight is allowed to land rather than asked for twice, and nothing here ever
   * reports a failure: the buttons are the paths that say what went wrong, and a
   * read that quietly could not be answered leaves the card showing the last
   * thing the host did say.
   */
  poll(): void {
    if (this.state.phase === 'loading') return
    void this.reloadStatus()
  }

  /** Re-read the status and fold it in without disturbing what is being typed. */
  private async reloadStatus(): Promise<void> {
    const answer = await requestStatus()
    if (!answer.ok) return
    if (this.state.dirty) {
      // Mid-edit, the draft is the person's: only the view is replaced, so a
      // status that arrived between two keystrokes cannot take a character back.
      this.set({ view: answer.data, error: '' })
      return
    }
    this.set({ error: '' })
    this.adopt(answer.data)
  }

  edit(field: DraftField, value: string): void {
    this.set({ [field]: value, dirty: true } as Partial<CardState>)
  }

  toggle(field: ToggleField, value: boolean): void {
    this.set({ [field]: value, dirty: true } as Partial<CardState>)
  }

  /**
   * Ask for a directory and stage it.
   *
   * A dialog that opened and was cancelled stages nothing: a cancel must not
   * leave a row behind. A dialog that cannot be reached at all leaves one blank
   * row instead, which is the one way left to name a path by hand.
   */
  pickDir(): void {
    // Silently does nothing at the cap: the button that calls this is disabled
    // there, and a row that cannot be saved is worse than no row.
    if (this.state.dirs.length >= DIRS_MAX) return
    const choose = this.choose
    if (choose === undefined) {
      this.appendDir('')
      return
    }
    void choose().then(
      (chosen) => {
        const path = (chosen ?? '').trim()
        if (path !== '') this.appendDir(path)
      },
      () => this.appendDir(''),
    )
  }

  /** Stage a row at the end of the list, unless that exact path is already on it. */
  private appendDir(path: string): void {
    if (this.state.dirs.length >= DIRS_MAX) return
    if (path !== '' && this.state.dirs.includes(path)) return
    this.set({ dirs: [...this.state.dirs, path], dirty: true })
  }

  editDir(index: number, path: string): void {
    if (index < 0 || index >= this.state.dirs.length) return
    const dirs = [...this.state.dirs]
    dirs[index] = path
    this.set({ dirs, dirty: true })
  }

  removeDir(index: number): void {
    if (index < 0 || index >= this.state.dirs.length) return
    this.set({ dirs: this.state.dirs.filter((_, at) => at !== index), dirty: true })
  }

  setAuto(minutes: number): void {
    if (!AUTO_CHOICES.includes(minutes)) return
    this.set({ autoEvery: minutes, dirty: true })
  }

  nextPort(): void {
    // Stopping at the top rather than wrapping: a port of 1 is not a useful
    // place to send someone who has run out of ports.
    if (this.state.relayPort >= 65_535) return
    this.set({ relayPort: this.state.relayPort + 1, dirty: true })
  }

  reset(): void {
    const view = this.state.view
    if (view === undefined) return
    this.set({ preview: undefined, message: '', messageFailed: false, installOutput: '', confirm: '', reloadNeeded: false })
    this.adopt(view)
  }

  /** The draft as the host's configure body. */
  private body(extra: Partial<ConfigureBody> = {}): ConfigureBody {
    return {
      url: this.state.url,
      user: this.state.user,
      // Blank means "keep what is stored": the host reads it that way.
      password: this.state.password,
      passphrase: this.state.passphrase,
      headers: this.state.headers,
      autoEvery: this.state.autoEvery,
      models: this.state.models,
      defaults: this.state.defaults,
      plugins: this.state.plugins,
      patch: this.state.patch,
      dirs: this.state.dirs,
      dirsEnabled: this.state.dirsEnabled,
      rememberPassword: this.state.rememberPassword,
      relayEnabled: this.state.relayEnabled,
      relayPort: this.state.relayPort,
      ...extra,
    }
  }

  save(): void {
    void this.run(
      'save',
      () => requestConfigure(this.body()),
      () => ({ dirty: false, message: '', messageFailed: false }),
    ).then(() => this.load())
  }

  check(): void {
    void this.run('check', () => requestCheck(), (result) => ({
      message: String((result as { message?: unknown }).message ?? ''),
      messageFailed: !(result as { ok?: unknown }).ok,
    }))
  }

  preview(): void {
    void this.run('preview', () => requestPreview(), (result) => ({
      preview: result as unknown as PreviewResult,
      reloadNeeded: false,
    }))
  }

  sync(): void {
    void this.run(
      'sync',
      () => requestSync({ force: true }),
      (result) => ({
        preview: undefined,
        reloadNeeded: (result as { reloadNeeded?: unknown }).reloadNeeded === true,
      }),
    ).then(() => this.load())
  }

  askRestore(): void {
    this.set({ confirm: 'restore' })
  }

  askUpload(): void {
    this.set({ confirm: 'upload' })
  }

  askOff(): void {
    this.set({ confirm: 'off' })
  }

  undo(): void {
    void this.run('undo', () => requestUndo(), (result) => ({
      reloadNeeded: (result as { reloadNeeded?: unknown }).reloadNeeded === true,
      preview: undefined,
    })).then(() => this.load())
  }

  install(): void {
    void this.run('install', () => requestInstall(), (result) => ({
      installOutput: String((result as { output?: unknown }).output ?? ''),
      messageFailed: (result as { ok?: unknown }).ok !== true,
    })).then(() => this.load())
  }

  dismiss(): void {
    void this.run('dismiss', () => requestDismiss(), () => ({})).then(() => this.load())
  }

  answer(yes: boolean): void {
    const kind = this.state.confirm
    this.set({ confirm: '' })
    if (!yes) return
    if (kind === 'restore') {
      void this.run('restore', () => requestRestore(), (result) => ({
        reloadNeeded: (result as { reloadNeeded?: unknown }).reloadNeeded === true,
        preview: undefined,
      })).then(() => this.load())
      return
    }
    if (kind === 'upload') {
      void this.run('upload', () => requestUpload(), (result) => ({
        preview: undefined,
        messageFailed: false,
        reloadNeeded: (result as { reloadNeeded?: unknown }).reloadNeeded === true,
      })).then(() => this.load())
      return
    }
    if (kind === 'off') {
      void this.run('off', () => requestOff(), () => ({ preview: undefined })).then(() => this.load())
    }
  }

  /** Every action as plain methods, for the inject face and for tests. */
  actions(): CardActions {
    return {
      ensure: () => this.ensure(),
      refresh: () => this.refresh(),
      poll: () => this.poll(),
      edit: (field, value) => this.edit(field, value),
      toggle: (field, value) => this.toggle(field, value),
      pickDir: () => this.pickDir(),
      editDir: (index, path) => this.editDir(index, path),
      removeDir: (index) => this.removeDir(index),
      setAuto: (minutes) => this.setAuto(minutes),
      nextPort: () => this.nextPort(),
      reset: () => this.reset(),
      save: () => this.save(),
      check: () => this.check(),
      preview: () => this.preview(),
      sync: () => this.sync(),
      askRestore: () => this.askRestore(),
      undo: () => this.undo(),
      askUpload: () => this.askUpload(),
      askOff: () => this.askOff(),
      answer: (yes) => this.answer(yes),
      install: () => this.install(),
      dismiss: () => this.dismiss(),
    }
  }
}
