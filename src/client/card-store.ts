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
  requestExport,
  requestImport,
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
import {
  AUTO_CHOICES,
  AUTO_MANUAL,
  DIRS_MAX,
  RELAY_DEFAULT_PORT,
  type ConfigureBody,
  type ExportResult,
  type ImportResult,
  type KeyProblem,
  type PreviewResult,
  type StatusResult,
} from '../wire.ts'

/** Which of the four big actions is in flight, for the button that shows it. */
export type CardBusy =
  | ''
  | 'save'
  | 'check'
  | 'preview'
  | 'sync'
  | 'restore'
  | 'undo'
  | 'upload'
  | 'install'
  | 'off'
  | 'dismiss'
  | 'export'
  | 'import'

/** A confirmation the card is waiting on before doing something destructive. */
export type CardConfirm = '' | 'restore' | 'upload' | 'off'

/** The two text fields of the export form. */
export type ExportField = 'passphrase' | 'dir'

/** The one text field of the import form: the file itself arrives as text. */
export type ImportField = 'passphrase'

/**
 * The keys an action could not write, as the host reported them.
 *
 * Every action that applies a merge answers with the same field, and an absent one
 * means every key went in — so this reads both shapes as "no problems" rather than
 * making each caller remember which.
 */
function keyProblemsOf(result: unknown): KeyProblem[] {
  const held = (result as { keysProblems?: unknown }).keysProblems
  return Array.isArray(held) ? (held as KeyProblem[]) : []
}

/**
 * The keys an action wrote here, as the host reported them.
 *
 * Names, never values. An absent field means nothing had to be written — the two
 * sides already held the same set — so this reads as "nothing arrived" rather
 * than as a failure, the mirror of {@link keyProblemsOf}.
 */
function keysWrittenOf(result: unknown): string[] {
  const held = (result as { keysWritten?: unknown }).keysWritten
  return Array.isArray(held) ? (held as string[]) : []
}

/**
 * The stable serialization a host-recomputed prompt is dismissed by.
 *
 * It must match what the host computes for the same payload, and it does: both
 * sides serialise the same plain value — the missing-plugin names, the
 * directory problems, the key problems — with a plain `JSON.stringify`, and
 * the host builds those payloads sorted. Keeping the two to one identical
 * expression is the whole contract, so the helper lives where the card can
 * see the payloads it dismisses.
 */
export function signatureOf(payload: unknown): string {
  return JSON.stringify(payload)
}

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
   * The row being typed into, if any.
   *
   * A row is a text box only while it is being written in: it holds nothing yet,
   * or it was just opened. Deciding that from the path alone would close the box
   * as soon as the first character landed in it.
   */
  editingDir: number | null
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
  plugins: boolean
  patch: boolean
  /**
   * Whether this computer's stored API keys travel.
   *
   * On by default: the profile names where its keys come from, so a setup that
   * arrives without them names providers that cannot authenticate. Off keeps them
   * off the server entirely, and deletes nothing here.
   */
  keys: boolean
  /**
   * Whether this computer's MCP rows travel.
   *
   * On by default: they have ridden along with the rest of the profile all along,
   * so a setup that arrives without them names servers DSH cannot start. Off
   * keeps this computer's rows to itself and carries the server's copy through —
   * nobody else's rows are removed for it.
   */
  mcp: boolean
  /**
   * Whether the skill folders under `$DSH_HOME/skills` travel.
   *
   * On by default: a folder somebody put there is setup like any other. Off
   * keeps this computer's folders to itself, and nothing is deleted for anybody
   * else — the same bargain the extra directories strike.
   */
  skills: boolean
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
  /**
   * Whether that install failed.
   *
   * Its own flag rather than {@link messageFailed}: the report outlives the action
   * that produced it, and a later failure from something else — a check, a sync —
   * must not relabel a log that is still on screen.
   */
  installFailed: boolean
  /**
   * Keys the last sync, restore or undo could not write here, with the reason.
   *
   * Kept beside the status's own list rather than inside it: that one says what
   * could not be *read*, this one what could not be *written*, and the two are
   * different failures with the same remedy.
   */
  keysProblems: KeyProblem[]
  /**
   * Reference names the last action stored a value under — the keys that arrived
   * from the server.
   *
   * Its own field rather than part of the status, for the same reason as
   * {@link keysProblems}: only an action can know it, since it is the act of
   * writing that tells a key apart from one already held. It needs no close
   * button — the next action replaces it, and an action that stored nothing
   * clears it — so it cannot outlive the run that made it true.
   */
  keysWritten: string[]
  /**
   * Whether an applied merge left configuration files changed on disk.
   *
   * It survives status reads on purpose: the disk has really changed, and one
   * render of the note is easy to miss. That is also why it carries its own
   * close button instead of waiting for the next action to clear it.
   */
  reloadNeeded: boolean
  /** The confirmation the card is holding, if any. */
  confirm: CardConfirm

  // ---- manual backup ----
  /**
   * Whether the export form is open.
   *
   * The two rows are the whole section until one of them is used: a passphrase
   * field and a folder field on screen at all times would read as settings to
   * fill in and keep, when they are one file's two questions.
   */
  exportOpen: boolean
  /** The passphrase the export file will be sealed with. */
  exportPassphrase: string
  /** Where the file goes: a directory or a full path; blank means the home folder. */
  exportDir: string
  /** Whether the import form is open. */
  importOpen: boolean
  /** The passphrase the picked file was sealed with. */
  importPassphrase: string
  /** The picked file's name, for the row to say which file is about to be read. */
  importName: string
  /** The picked file's text, as the browser read it. */
  importText: string
  /**
   * The export that last finished, for the section to report.
   *
   * Kept as the host's answer rather than a sentence: the file name, its size and
   * the parts it carried are all worth showing, and the wording belongs to the
   * card, which is the half that knows the reader's language.
   */
  exported: ExportResult | undefined
  /** The import that last finished, for the section to report. */
  imported: ImportResult | undefined
}

/**
 * Which host-recomputed prompt a dismiss targets.
 *
 * These are the prompts the host says again on every status read because the
 * facts behind them stand: a hidden one is put away by asking the host to
 * remember what was on screen, not by clearing a field this side holds.
 */
export type PromptDismissTarget = 'pending-install' | 'dir-problems' | 'skill-problems' | 'key-problems'

/** What the card can ask the host to do. */
export interface CardActions {
  /** Read the status once, if it has not been read. */
  ensure(): void
  /** Re-read the status without syncing or discarding the draft. */
  refresh(): void
  /** Re-read on a timer or foreground event, preserving the draft. */
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
  /**
   * Hide one host-recomputed prompt — the missing-plugins line, the directory
   * problems, the key problems — until its content changes.
   *
   * The signature of what is on screen travels with the request: the host
   * remembers exactly that payload and keeps quiet only while it stays the
   * same. A different plugin list or a different broken directory signs
   * differently and is shown, so hiding never grows into ignoring.
   */
  dismissPrompt(target: PromptDismissTarget, signature: string): void
  /**
   * Put the install report away.
   *
   * Local and immediate: the log is this browser's memory of one run, so there is
   * nothing for the host to forget and nothing to ask it. Kept apart from
   * {@link dismiss}, which is about the host's notice of what a sync moved.
   */
  closeOutput(): void
  /** Put the preview away — including the "both sides agree" line. */
  closePreview(): void
  /** Put the action's outcome sentence away. */
  closeMessage(): void
  /** Put the "the status could not be read" line away. */
  closeError(): void
  /** Put the "reload the interface" note away. */
  closeReload(): void
  /** Put the keys a sync could not write here away. */
  closeKeyProblems(): void
  /** Put the export report away. */
  closeExportReport(): void
  /** Put the import report away. */
  closeImportReport(): void

  // ---- manual backup ----
  /** Open the export form (a passphrase and a place to put the file). */
  openExport(): void
  /** Close the export form and forget what was typed into it. */
  closeExport(): void
  /** Stage one field of the export form. */
  editExport(field: ExportField, value: string): void
  /** Ask for a folder to save the file into. */
  pickExportDir(): void
  /** Write the sealed file. */
  runExport(): void
  /** Open the import form. */
  openImport(): void
  /** Close the import form and forget the file that was picked. */
  closeImport(): void
  /** Stage the import file's passphrase. */
  editImport(field: ImportField, value: string): void
  /**
   * Take the file the person picked and keep its text for the import.
   *
   * The text is read here rather than by the host because only this half can see
   * a file the person picked in the browser.
   */
  pickFile(file: File): void
  /** Put what the picked file holds onto this computer. */
  runImport(): void
}

/** The draft's text fields. */
export type DraftField = 'url' | 'user' | 'password' | 'passphrase' | 'headers'
/** The draft's switches. */
export type ToggleField =
  | 'rememberPassword'
  | 'models'
  | 'plugins'
  | 'patch'
  | 'keys'
  | 'mcp'
  | 'skills'
  | 'dirsEnabled'
  | 'relayEnabled'

/** An observable card state source: `getSnapshot` is stable between changes. */
export interface CardStore {
  getSnapshot(): CardState
  subscribe(listener: () => void): () => void
}

/** How big a picked import file may be — the same ceiling the host reads with. */
const IMPORT_PICK_LIMIT = 32 * 1024 * 1024

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
  editingDir: null,
  dirsEnabled: false,
  rememberPassword: true,
  autoEvery: AUTO_MANUAL,
  models: true,
  plugins: true,
  patch: true,
  keys: true,
  mcp: true,
  skills: true,
  relayEnabled: false,
  relayPort: RELAY_DEFAULT_PORT,
  dirty: false,
  busy: '',
  message: '',
  messageFailed: false,
  preview: undefined,
  installOutput: '',
  installFailed: false,
  keysProblems: [],
  keysWritten: [],
  reloadNeeded: false,
  confirm: '',
  exportOpen: false,
  exportPassphrase: '',
  exportDir: '',
  importOpen: false,
  importPassphrase: '',
  importName: '',
  importText: '',
  exported: undefined,
  imported: undefined,
}

/** The card: an observable snapshot, the staged draft, and every write. */
export class WebdavSyncCard implements CardStore, CardActions {
  private state: CardState = EMPTY
  private readonly listeners = new Set<() => void>()
  private started = false
  private statusSequence = 0
  private statusReads = 0
  /** Counts file picks, so only the newest pick's read writes back. */
  private pickSequence = 0

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
      editingDir: null,
      // A host from before this switch existed answers without it, and the
      // resting state of a fresh configuration is off: the part is read off the
      // disk and written back, which is the one thing a switch should not start
      // doing on its own. An absent flag reads as off, the same way the host
      // writes it.
      dirsEnabled: view.config.dirsEnabled ?? false,
      // The rest of the switches read as the host's own defaults when a host
      // from before a field existed answers without it — the same mercy the
      // fields above get, kept to the values `defaultConfig()` rests on.
      rememberPassword: view.config.rememberPassword ?? true,
      autoEvery: view.config.autoEvery ?? AUTO_MANUAL,
      models: view.config.models ?? true,
      plugins: view.config.plugins ?? true,
      patch: view.config.patch ?? true,
      // On, unlike the directories: a host too old to know this part has no keys
      // of its own to send anyway, so an absent flag reads as on. The two parts
      // below get the same mercy — a host from before they were named has been
      // carrying the MCP rows along with the profile all along, and has no skill
      // folders of its own to send.
      keys: view.config.keys ?? true,
      mcp: view.config.mcp ?? true,
      skills: view.config.skills ?? true,
      // A host from before the forwarder existed answers without these: off and
      // the default port, which is what such a host is doing.
      relayEnabled: view.config.relayEnabled ?? false,
      relayPort: view.config.relayPort ?? RELAY_DEFAULT_PORT,
      dirty: false,
    })
  }

  /**
   * Run one call and fold its outcome into the state.
   *
   * Answers whether the call succeeded: a caller that re-reads the status after
   * an action only wants to on success — a refused save must leave the draft as
   * it is, or the error message would be all that was left of what the person
   * typed.
   */
  private async run(kind: CardBusy, call: () => Promise<Call<unknown>>, describe: (result: unknown) => Partial<CardState>): Promise<boolean> {
    // One action at a time. The buttons are disabled while one runs, but the
    // prompt rows' close buttons are actions too, and a second action landing
    // before the first ends would clear `busy` early — every button back while
    // the first call is still in flight on the host.
    if (this.state.busy !== '') return false
    this.set({ busy: kind, message: '', messageFailed: false })
    const answer = await call()
    if (!answer.ok) {
      this.set({ busy: '', message: answer.error, messageFailed: true })
      return false
    }
    this.set({ busy: '', ...describe(answer.data) })
    return true
  }

  ensure(): void {
    if (this.started) return
    this.started = true
    void this.load()
  }

  async load(): Promise<void> {
    this.statusReads += 1
    const sequence = ++this.statusSequence
    this.set({ phase: this.state.view === undefined ? 'loading' : this.state.phase, error: '' })
    try {
      const answer = await requestStatus()
      if (sequence !== this.statusSequence) return
      if (!answer.ok) {
        this.set({ phase: 'ready', error: answer.error })
        return
      }
      // A draft with unsaved edits is not reset by an action's follow-up read —
      // the same protection the periodic read gives. An action that succeeded
      // with a clean form clears `dirty` before this runs, so the fresh view is
      // adopted exactly when there is nothing typed to lose.
      if (this.state.dirty) {
        this.set({ phase: 'ready', view: answer.data, error: '' })
        return
      }
      this.adopt(answer.data)
    } finally {
      this.statusReads -= 1
    }
  }

  /** A manual status refresh, not a sync and not a reset of the draft. */
  refresh(): void {
    this.poll()
  }

  /** Periodic and foreground reads share one bounded request per card. */
  poll(): void {
    if (this.state.phase === 'loading' || this.statusReads > 0) return
    void this.reloadStatus()
  }

  /** Re-read the status and fold it in without disturbing what is being typed. */
  private async reloadStatus(): Promise<void> {
    this.statusReads += 1
    const sequence = ++this.statusSequence
    try {
      const answer = await requestStatus()
      if (sequence !== this.statusSequence) return
      if (!answer.ok) {
        // Keep the last known data, but never silently present it as current.
        this.set({ phase: 'ready', error: answer.error })
        return
      }
      if (this.state.dirty) {
        this.set({ phase: 'ready', view: answer.data, error: '' })
        return
      }
      this.set({ error: '' })
      this.adopt(answer.data)
    } finally {
      this.statusReads -= 1
    }
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
    // A row that arrives empty is the one the user is about to type into; a row
    // that arrives with a path is already finished.
    this.set({
      dirs: [...this.state.dirs, path],
      editingDir: path === '' ? this.state.dirs.length : null,
      dirty: true,
    })
  }

  editDir(index: number, path: string): void {
    if (index < 0 || index >= this.state.dirs.length) return
    const dirs = [...this.state.dirs]
    dirs[index] = path
    this.set({ dirs, dirty: true })
  }

  removeDir(index: number): void {
    if (index < 0 || index >= this.state.dirs.length) return
    const editing = this.state.editingDir
    this.set({
      dirs: this.state.dirs.filter((_, at) => at !== index),
      // The row that was being typed into is gone; one below it moves up.
      editingDir: editing === null || editing === index ? null : editing > index ? editing - 1 : editing,
      dirty: true,
    })
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
    this.set({
      preview: undefined,
      message: '',
      messageFailed: false,
      installOutput: '',
      installFailed: false,
      confirm: '',
      reloadNeeded: false,
    })
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
      plugins: this.state.plugins,
      patch: this.state.patch,
      keys: this.state.keys,
      mcp: this.state.mcp,
      skills: this.state.skills,
      dirs: this.state.dirs,
      dirsEnabled: this.state.dirsEnabled,
      rememberPassword: this.state.rememberPassword,
      relayEnabled: this.state.relayEnabled,
      relayPort: this.state.relayPort,
      ...extra,
    }
  }

  /** Re-read only after a save the host took: a refused one leaves the draft. */
  private after(call: Promise<boolean>): void {
    void call.then((ok) => (ok ? this.load() : undefined))
  }

  save(): void {
    this.after(this.run(
      'save',
      () => requestConfigure(this.body()),
      () => ({ dirty: false, message: '', messageFailed: false }),
    ))
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
    }))
  }

  sync(): void {
    this.after(this.run(
      'sync',
      () => requestSync({ force: true }),
      (result) => ({
        preview: undefined,
        reloadNeeded: (result as { reloadNeeded?: unknown }).reloadNeeded === true,
        keysProblems: keyProblemsOf(result),
        keysWritten: keysWrittenOf(result),
      }),
    ))
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
    this.after(this.run('undo', () => requestUndo(), (result) => ({
      reloadNeeded: (result as { reloadNeeded?: unknown }).reloadNeeded === true,
      preview: undefined,
      keysProblems: keyProblemsOf(result),
    })))
  }

  install(): void {
    this.after(this.run('install', () => requestInstall(), (result) => ({
      installOutput: String((result as { output?: unknown }).output ?? ''),
      installFailed: (result as { ok?: unknown }).ok !== true,
      messageFailed: false,
    })))
  }

  dismiss(): void {
    this.after(this.run('dismiss', () => requestDismiss(), () => ({})))
  }

  dismissPrompt(target: PromptDismissTarget, signature: string): void {
    // The signature sent is the one computed from the very payload on screen,
    // which is what the host will compare its next read against. The read that
    // follows confirms the line is gone; a failure leaves the prompt standing,
    // which is the honest answer.
    this.after(this.run('dismiss', () => requestDismiss({ target, signature }), () => ({})))
  }

  closeOutput(): void {
    this.set({ installOutput: '', installFailed: false })
  }

  closePreview(): void {
    this.set({ preview: undefined })
  }

  closeMessage(): void {
    this.set({ message: '', messageFailed: false })
  }

  closeError(): void {
    this.set({ error: '' })
  }

  closeReload(): void {
    this.set({ reloadNeeded: false })
  }

  closeKeyProblems(): void {
    this.set({ keysProblems: [] })
  }

  closeExportReport(): void {
    this.set({ exported: undefined })
  }

  closeImportReport(): void {
    this.set({ imported: undefined })
  }

  // ---- manual backup ----

  openExport(): void {
    // The stored sync passphrase is not offered here: the two are deliberately
    // different secrets, and filling this one in from the other would make one
    // leaked file open the sync as well.
    this.set({ exportOpen: true, importOpen: false, message: '', messageFailed: false })
  }

  closeExport(): void {
    this.set({ exportOpen: false, exportPassphrase: '', exportDir: '' })
  }

  editExport(field: ExportField, value: string): void {
    if (field === 'passphrase') {
      this.set({ exportPassphrase: value })
      return
    }
    this.set({ exportDir: value })
  }

  pickExportDir(): void {
    const choose = this.choose
    if (choose === undefined) {
      this.set({ message: '此界面不支持目录选择，请手动填写绝对路径，或留空保存到运行 DSH 的电脑用户主目录', messageFailed: true })
      return
    }
    void choose().then(
      (chosen) => {
        const path = (chosen ?? '').trim()
        if (path !== '') this.set({ exportDir: path, message: '', messageFailed: false })
      },
      () => this.set({ message: '目录选择未成功，请手动填写绝对路径，或留空保存到运行 DSH 的电脑用户主目录', messageFailed: true }),
    )
  }

  runExport(): void {
    if (this.state.busy !== '') return
    const passphrase = this.state.exportPassphrase.trim()
    if (passphrase === '') {
      this.set({ message: '导出需要一个口令来加密这个文件', messageFailed: true })
      return
    }
    void this.run(
      'export',
      () => requestExport({ passphrase, dir: this.state.exportDir.trim() }),
      (result) => ({
        exportOpen: false,
        exportPassphrase: '',
        exportDir: '',
        exported: result as ExportResult,
        imported: undefined,
        message: '',
        messageFailed: false,
      }),
    )
  }

  openImport(): void {
    this.set({ importOpen: true, exportOpen: false, message: '', messageFailed: false })
  }

  closeImport(): void {
    this.set({ importOpen: false, importPassphrase: '', importName: '', importText: '' })
  }

  editImport(field: ImportField, value: string): void {
    if (field === 'passphrase') this.set({ importPassphrase: value })
  }

  pickFile(file: File): void {
    // The host reads at most 32 MiB of text; a file bigger than that is refused
    // here rather than read into memory first — the reading itself is what
    // freezes the page on a file this size.
    if (file.size > IMPORT_PICK_LIMIT) {
      this.set({
        importName: '',
        importText: '',
        message: `这个文件有 ${Math.round(file.size / 1024 / 1024)} MiB，超过了导入上限 32 MiB：请选备份文件本身`,
        messageFailed: true,
      })
      return
    }
    // Only the last pick writes back: two picks racing on `text()` would
    // otherwise let the slower first file overwrite whichever file the person
    // settled on.
    const sequence = ++this.pickSequence
    void file.text().then(
      (text) => {
        if (sequence !== this.pickSequence) return
        this.set({ importName: file.name, importText: text, message: '', messageFailed: false })
      },
      (cause: unknown) => {
        if (sequence !== this.pickSequence) return
        this.set({
          importName: '',
          importText: '',
          message: `读不了这个文件：${cause instanceof Error ? cause.message : String(cause)}`,
          messageFailed: true,
        })
      },
    )
  }

  runImport(): void {
    if (this.state.busy !== '') return
    const passphrase = this.state.importPassphrase.trim()
    if (passphrase === '') {
      this.set({ message: '导入需要这个文件的口令', messageFailed: true })
      return
    }
    if (this.state.importText === '') {
      this.set({ message: '还没有选择文件', messageFailed: true })
      return
    }
    void this.run(
      'import',
      () => requestImport({ passphrase, text: this.state.importText }),
      (result) => ({
        importOpen: false,
        importPassphrase: '',
        importName: '',
        importText: '',
        exported: undefined,
        imported: result as ImportResult,
        reloadNeeded: (result as { reloadNeeded?: unknown }).reloadNeeded === true,
        keysProblems: keyProblemsOf(result),
        keysWritten: keysWrittenOf(result),
        message: '',
        messageFailed: false,
      }),
    ).then((ok) => (ok ? this.load() : undefined))
  }

  answer(yes: boolean): void {
    const kind = this.state.confirm
    this.set({ confirm: '' })
    if (!yes) return
    if (kind === 'restore') {
      this.after(this.run('restore', () => requestRestore(), (result) => ({
        reloadNeeded: (result as { reloadNeeded?: unknown }).reloadNeeded === true,
        preview: undefined,
        keysProblems: keyProblemsOf(result),
        keysWritten: keysWrittenOf(result),
      })))
      return
    }
    if (kind === 'upload') {
      this.after(this.run('upload', () => requestUpload(), (result) => ({
        preview: undefined,
        messageFailed: false,
        reloadNeeded: (result as { reloadNeeded?: unknown }).reloadNeeded === true,
        keysProblems: keyProblemsOf(result),
        keysWritten: keysWrittenOf(result),
      })))
      return
    }
    if (kind === 'off') {
      // `dirty` is cleared like a save does: turning sync off is a change the host
      // took, so the read that follows must replace the draft rather than be
      // skipped for edits that no longer mean anything — the interval control
      // reads its value from the draft, and would otherwise keep showing one.
      this.after(this.run('off', () => requestOff(), () => ({ preview: undefined, dirty: false })))
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
      dismissPrompt: (target, signature) => this.dismissPrompt(target, signature),
      closeOutput: () => this.closeOutput(),
      closePreview: () => this.closePreview(),
      closeMessage: () => this.closeMessage(),
      closeError: () => this.closeError(),
      closeReload: () => this.closeReload(),
      closeKeyProblems: () => this.closeKeyProblems(),
      closeExportReport: () => this.closeExportReport(),
      closeImportReport: () => this.closeImportReport(),
      openExport: () => this.openExport(),
      closeExport: () => this.closeExport(),
      editExport: (field, value) => this.editExport(field, value),
      pickExportDir: () => this.pickExportDir(),
      runExport: () => this.runExport(),
      openImport: () => this.openImport(),
      closeImport: () => this.closeImport(),
      editImport: (field, value) => this.editImport(field, value),
      pickFile: (file) => this.pickFile(file),
      runImport: () => this.runImport(),
    }
  }
}
