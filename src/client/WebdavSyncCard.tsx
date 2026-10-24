/**
 * The WebDAV sync card, rendered in two seats from one body:
 *
 * - `WebdavSyncBundleCard`, the keyed `plugins.bundle.config` entry for this
 *   package, so it shows on the bundle's row (`view: 'summary'`) and inside its
 *   page (`view: 'page'`) on the Plugins page;
 * - `WebdavSyncSection`, a `settings.section` page, so it is also reachable from
 *   Settings directly.
 *
 * Everything the card shows comes from the host half's status route. The card
 * never reads a profile file and never speaks WebDAV itself: the browser half is
 * a view plus the routes in `api.ts`.
 *
 * @module webdav-sync/client/WebdavSyncCard
 */

import { useEffect } from 'react'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import {
  Button,
  Checkbox,
  IconCloseOutlineRegular,
  IconRefreshOutlineRegular,
  Input,
  SegmentedControl,
  Tag,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { AUTO_CHOICES, AUTO_MANUAL, DIRS_MAX, type Part, type PartView } from '../wire.ts'
import { signatureOf } from './card-store.ts'
import type { CardActions, CardBusy, CardStore, ToggleField } from './card-store.ts'
import { ManualBackupPanel } from './ManualBackupPanel.tsx'
import { RelayPanel } from './RelayPanel.tsx'
import { NS, type WebdavSyncKey } from './locales.ts'
import { watchStatus } from './status-polling.ts'
import css from './WebdavSyncCard.module.css'

/** The registration-side face: the store and the actions. */
export interface WebdavSyncFace extends CardActions {
  hooks: {
    /** Card snapshot, bound by the renderer as `useWebdavSync`. */
    webdavSync: CardStore
  }
}

/** What both seats' props share. */
type CardSeatProps = PropsLocale<typeof NS> & InjectFace<WebdavSyncFace> & { view?: 'summary' | 'page' }

/** Props for the Plugins-page seat. */
export type WebdavSyncBundleProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<typeof NS>
  & InjectFace<WebdavSyncFace>
  & PluginConfigViewProps

/** Props for the Settings-page seat. */
export type WebdavSyncSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<typeof NS>
  & InjectFace<WebdavSyncFace>

/** Which dictionary key names each part. */
const PART_NAME: Record<Part, WebdavSyncKey> = {
  models: 'partModels',
  plugins: 'partPlugins',
  patch: 'partPatch',
  dirs: 'partDirs',
  keys: 'partKeys',
}

/** Which dictionary key says, in a line, what a part carries. */
const PART_HINT: Record<Part, WebdavSyncKey> = {
  models: 'partModelsHint',
  plugins: 'partPluginsHint',
  patch: 'partPatchHint',
  dirs: 'partDirsHint',
  keys: 'partKeysHint',
}

/**
 * The parts whose switch is a checkbox on their own row.
 *
 * The extra directories are a `part` too — they hash, merge and travel like the
 * profile parts — but there is no single boolean behind them: the list
 * itself is the part, so it is turned off by removing every row, and its rows
 * are edited one by one instead of behind one label. Filtering it out keeps the
 * checkbox loop honest, and the predicate is what tells the compiler so.
 */
function isToggledPart(view: PartView): view is PartView & { part: ToggleField } {
  return view.part !== 'dirs'
}

/** The value of the auto-sync control's first tab, which is not an interval. */
const AUTO_OFF = 'off'

/**
 * The ✕ of one removable prompt.
 *
 * Every prompt an operation puts on the card can be taken off again — that is
 * this card's own rule, so the control is one component rather than eight
 * separate buttons drifting apart. It is a 24px ghost icon (the shape the
 * heading's refresh takes) because a worded button would give a transient
 * message the visual weight of an action, and what a ✕ says needs no words;
 * the label is for the tooltip and the screen reader. Local prompts call it
 * with a plain clear, host-held ones with a target and the signature of the
 * payload on screen.
 */
function PromptClose({ t, onClick, disabled }: { t: (key: WebdavSyncKey) => string; onClick: () => void; disabled?: boolean }) {
  return (
    <Tooltip label={t('promptDismiss')} side="top" portal>
      <Button
        variant="ghost"
        size="sm"
        className={css.promptClose}
        icon={<IconCloseOutlineRegular />}
        aria-label={t('promptDismiss')}
        disabled={disabled}
        onClick={onClick}
      />
    </Tooltip>
  )
}

/** Which dictionary key names the action in flight. */
const BUSY_TEXT: Partial<Record<CardBusy, WebdavSyncKey>> = {
  check: 'check',
  preview: 'preview',
  sync: 'syncNow',
  restore: 'restore',
  undo: 'undo',
  upload: 'upload',
  install: 'install',
}

/** The one-line state of one part as the panel words it. */
function partStateKey(view: { localChanged: boolean; remoteChanged: boolean }): WebdavSyncKey {
  if (view.localChanged && view.remoteChanged) return 'partBoth'
  if (view.localChanged) return 'partOnlyHere'
  if (view.remoteChanged) return 'partOnlyThere'
  return 'partSynced'
}

/**
 * The state word of one part's row, asked with the draft the row is bound to.
 *
 * The box and this word sit in the same row and have to answer for the same
 * thing, so both read the draft. The host's `synced` says what the configuration
 * on disk carries, and `localChanged` / `remoteChanged` describe that same saved
 * configuration; while the draft disagrees with it, no word of the four is true —
 * "in step" and "off" both speak about a save that has not happened yet. The row
 * then says the one thing that is the case: the change is waiting for the save.
 */
function rowStateKey(draft: boolean, view: PartView): WebdavSyncKey {
  if (draft !== view.synced) return 'partUnsaved'
  return draft ? partStateKey(view) : 'partOff'
}

/**
 * The last sync time as this computer's own clock reads it: the host stores an
 * ISO string in UTC, which is not what a person recognises at a glance.
 */
function whenText(at: string): string {
  const when = new Date(at)
  return Number.isNaN(when.getTime()) ? at : when.toLocaleString()
}

/**
 * The auto-sync tabs, in the order the card shows them: off first, then by
 * hand, then the intervals. Off is not an interval but a way out, so it is
 * worded as its own tab instead of an extra choice at the end.
 */
function autoOptions(t: (key: WebdavSyncKey, params?: Record<string, unknown>) => string) {
  return [
    { value: AUTO_OFF, label: t('autoOff') },
    { value: String(AUTO_MANUAL), label: t('autoManual') },
    ...AUTO_CHOICES.filter((minutes) => minutes !== AUTO_MANUAL).map((minutes) => ({
      value: String(minutes),
      label: minutes % 60 === 0 ? t('autoHour', { n: minutes / 60 }) : t('autoEvery', { n: minutes }),
    })),
  ]
}

/** The card body. One render path, so the two seats never drift apart. */
function Card(props: CardSeatProps) {
  const { t } = props
  // The Settings seat has no `view`: only the bundle row asks for a summary.
  const onPage = props.view !== 'summary'
  const state = props.useWebdavSync((snapshot) => snapshot)

  // Both seats read the status once: the bundle row's summary is drawn from it,
  // so a person who never opens the settings page still sees a truthful line
  // there. Only the page seat keeps polling — the summary has no facts of its
  // own to refresh.
  useEffect(() => {
    props.ensure()
  }, [props.ensure])

  useEffect(() => {
    if (!onPage) return undefined
    return watchStatus(props.poll)
  }, [onPage, props.poll])

  if (state.phase === 'loading') {
    return onPage ? <p className={css.note} role="status">{t('working')}</p> : null
  }

  const config = state.view?.config

  if (!onPage) {
    const summary =
      config === undefined || !config.passphraseSet
        ? t('cardSummaryOff')
        : config.url === ''
          ? t('cardSummaryUnset')
          : t('cardSummaryOn', { url: config.url })
    return (
      <p className={css.summary}>
        <span className={css.summaryText}>{summary}</span>
      </p>
    )
  }

  if (config === undefined) {
    return (
      <div className={css.page}>
        <p className={css.failed} role="alert">{state.error || t('unavailable')}</p>
        <div className={css.footer}>
          {/*
            * Same action, same shape as the row below: a text button. Here it is
            * also the only thing on the card, so it takes the accent colour
            * rather than the ordinary label colour the six use.
            */}
          <Button
            variant="ghost"
            size="sm"
            className={`${css.textAction} ${css.textActionPrimary}`}
            onClick={() => props.refresh()}
          >
            {t('refreshStatus')}
          </Button>
        </div>
      </div>
    )
  }

  const busy = state.busy !== ''
  const busyKey = BUSY_TEXT[state.busy]
  // The extra-directories part has no checkbox of its own (see `isToggledPart`),
  // so its state line is read out here, next to the rows it describes.
  const dirsPart = (state.view?.parts ?? []).find((part) => part.part === 'dirs')
  const confirmText =
    state.confirm === 'restore'
      ? t('confirmRestore')
      : state.confirm === 'upload'
        ? t('confirmUpload')
        : state.confirm === 'off'
          ? t('confirmOff')
          : ''

  return (
    <div className={css.page}>
      {/*
        * A status read that failed says so here. The polling retries by itself,
        * but between retries the line sits at the top of the card, and a person
        * who has read it can take it down rather than wait it out: one of the
        * card's own rules is that nothing an operation left saying has to stay.
        * Clearing it is local — the next failed read writes it straight back,
        * which is the correct answer to a network that is still down.
        */}
      {state.error !== '' && (
        <div className={css.promptRow}>
          <p className={css.failed} role="alert">{t('statusStale')} {state.error}</p>
          <PromptClose t={t} onClick={() => props.closeError()} />
        </div>
      )}

      <section className={css.section}>
        <h4 className={css.legend}>{t('addressLegend')}</h4>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="webdav-sync-url">{t('urlLabel')}</label>
          <Input
            id="webdav-sync-url"
            value={state.url}
            spellCheck={false}
            placeholder="https://dav.jianguoyun.com/dav/"
            onChange={(event) => props.edit('url', event.target.value)}
          />
        </div>
        <div className={css.grid}>
          <div className={css.field}>
            <label className={css.fieldLabel} htmlFor="webdav-sync-user">{t('userLabel')}</label>
            <Input
              id="webdav-sync-user"
              value={state.user}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => props.edit('user', event.target.value)}
            />
          </div>
          <div className={css.field}>
            <div className={css.labelRow}>
              <label className={css.fieldLabel} htmlFor="webdav-sync-password">{t('passwordLabel')}</label>
              <Checkbox
                checked={state.rememberPassword}
                label={t('rememberPassword')}
                onChange={(next) => props.toggle('rememberPassword', next)}
              />
            </div>
            <Input
              id="webdav-sync-password"
              type="password"
              value={state.password}
              autoComplete="new-password"
              placeholder={config.passwordSet ? '••••••••' : ''}
              onChange={(event) => props.edit('password', event.target.value)}
            />
          </div>
        </div>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="webdav-sync-passphrase">{t('passphraseLabel')}</label>
          <p className={css.fieldHint}>{t('passphraseHint')}</p>
          <Input
            id="webdav-sync-passphrase"
            type="password"
            value={state.passphrase}
            autoComplete="new-password"
            placeholder={config.passphraseSet ? '••••••••' : ''}
            onChange={(event) => props.edit('passphrase', event.target.value)}
          />
        </div>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="webdav-sync-headers">{t('headersLabel')}</label>
          <textarea
            id="webdav-sync-headers"
            className={css.headersArea}
            rows={3}
            spellCheck={false}
            autoComplete="off"
            placeholder={t('headersPlaceholder')}
            value={state.headers}
            onChange={(event) => props.edit('headers', event.target.value)}
          />
        </div>
      </section>

      <section className={css.section}>
        <h4 className={css.legend}>{t('autoLegend')}</h4>
        <SegmentedControl
          id="webdav-sync-auto"
          className={css.autoControl}
          label={t('autoLegend')}
          // Off is not a stored interval: turning sync off clears the address,
          // so an empty address is what the Off tab stands for.
          value={state.url.trim() === '' ? AUTO_OFF : String(state.autoEvery)}
          disabled={busy}
          options={autoOptions(t)}
          onChange={(next) => {
            // The first tab is not an interval: it is the way out of syncing,
            // and it goes through the same confirmation the button used to.
            if (next === AUTO_OFF) props.askOff()
            else props.setAuto(Number(next))
          }}
        />
      </section>

      <section className={css.section}>
        {/*
          * The section's heading carries its one read-only action: reading the
          * status again is about exactly this list — the parts and the two
          * stamps below it — so the button sits on that title instead of at the
          * bottom of the list. It is an icon because the heading is 12px and a
          * word there would outrank the rows it describes; the tooltip and the
          * accessible name are where the words go.
          */}
        <h4 className={`${css.legend} ${css.legendAction}`}>
          {t('partsLegend')}
          <Tooltip label={t('refreshStatus')} side="top" portal>
            <Button
              variant="ghost"
              size="sm"
              className={css.legendIcon}
              icon={<IconRefreshOutlineRegular />}
              aria-label={t('refreshStatus')}
              onClick={() => props.refresh()}
            />
          </Tooltip>
        </h4>
        {(state.view?.parts ?? []).filter(isToggledPart).map((part) => {
          // The box reads the draft, not the status. `Checkbox` is controlled: a
          // box bound to `part.synced` is drawn from the status the host computed
          // before this edit, so the click wrote the draft and then the same
          // stored value was drawn straight back — the box looked dead until a
          // save reloaded the status.
          const on = state[part.part]
          const stateKey: WebdavSyncKey = rowStateKey(on, part)
          return (
            <div className={css.partRow} key={part.part}>
              <span className={css.partText}>
                <Checkbox
                  checked={on}
                  label={t(PART_NAME[part.part])}
                  title={t('partOffHint')}
                  onChange={(next) => props.toggle(part.part, next)}
                />
                <span className={css.partHint}>{t(PART_HINT[part.part])}</span>
              </span>
              <span className={stateKey === 'partBoth' ? `${css.partState} ${css.partStateBoth}` : css.partState}>
                {t(stateKey)}
              </span>
            </div>
          )
        })}
        {/*
          * The extra directories are a part like the four above: same checkbox,
          * same state at the right. Their switch says whether this computer
          * carries the list at all, not which directories are on it, so switching
          * it off leaves the paths on screen — and, because a part the
          * configuration leaves out is carried through untouched, it never
          * deletes them anywhere. The picker is a plain text button on the title
          * line, right after the name, and the chosen paths sit under the row, one
          * card each. A host from before this part reports no state at all; then the
          * row shows the switch alone.
          */}
        <div className={css.dirList}>
          <div className={css.partRow}>
            <span className={css.partText}>
              <span className={css.titleRow}>
                <Checkbox
                  checked={state.dirsEnabled}
                  label={t('partDirs')}
                  title={t('partOffHint')}
                  onChange={(next) => props.toggle('dirsEnabled', next)}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || state.dirs.length >= DIRS_MAX}
                  onClick={() => props.pickDir()}
                >
                  {t('chooseDir')}
                </Button>
              </span>
              <span className={css.partHint}>{t('partDirsHint')}</span>
            </span>
            {dirsPart !== undefined && (
              <span className={css.partState}>
                {t(rowStateKey(state.dirsEnabled, dirsPart))}
              </span>
            )}
          </div>
          {state.dirs.map((path, index) => (
            <div className={state.dirsEnabled ? css.dirRow : `${css.dirRow} ${css.dirOff}`} key={index}>
              {path === '' ? (
                <Input
                  id={`webdav-sync-dir-${index}`}
                  value={path}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={t('dirPlaceholder')}
                  disabled={busy}
                  onChange={(event) => props.editDir(index, event.target.value)}
                />
              ) : (
                <span className={css.dirPath} title={path}>{path}</span>
              )}
              <Button variant="outline" size="sm" disabled={busy} onClick={() => props.removeDir(index)}>
                {t('dirRemove')}
              </Button>
            </div>
          ))}
        </div>
        {(state.view?.dirProblems ?? []).map((problem) => (
          <p className={css.problem} role="status" key={problem.path}>
            {t('dirProblem', { path: problem.path, message: problem.message })}
          </p>
        ))}
        {(state.view?.dirProblems ?? []).length > 0 && (
          <PromptClose
            t={t}
            disabled={busy}
            onClick={() => props.dismissPrompt('dir-problems', signatureOf(state.view?.dirProblems ?? []))}
          />
        )}
        {/* A key that could not be read is said for the same reason a directory is:
          * the sync has to be told apart from this computer simply having no keys.
          * A failure of the store itself is not about one name, and the wire says so
          * with an empty one. */}
        {(state.view?.keysProblems ?? []).map((problem) => (
          <p className={css.problem} role="status" key={problem.ref}>
            {problem.ref === ''
              ? t('keyStoreProblem', { message: problem.message })
              : t('keyProblem', { ref: problem.ref, message: problem.message })}
          </p>
        ))}
        {(state.view?.keysProblems ?? []).length > 0 && (
          <PromptClose
            t={t}
            disabled={busy}
            onClick={() => props.dismissPrompt('key-problems', signatureOf(state.view?.keysProblems ?? []))}
          />
        )}
        {/* The same two sentences again for the last action, because a key that
          * could not be written is only known once something tried to write it:
          * the status above is about reading, and the person has to be told which
          * of the two happened. This one is the action's own report, so taking it
          * down is local — the status's list above stays as it is. */}
        {state.keysProblems.map((problem) => (
          <p className={css.problem} role="status" key={`last-${problem.ref}`}>
            {problem.ref === ''
              ? t('keyStoreProblem', { message: problem.message })
              : t('keyProblem', { ref: problem.ref, message: problem.message })}
          </p>
        ))}
        {state.keysProblems.length > 0 && <PromptClose t={t} onClick={() => props.closeKeyProblems()} />}
        {/* One line for both stamps: the check on the left, the sync on the right.
          * They are read as a pair, and a second line would only cost height. */}
        <div className={css.times}>
          <span className={css.hint}>
            {state.view?.last === undefined ? t('neverChecked') : t('lastCheck', { at: whenText(state.view.last) })}
          </span>
          <span className={css.hint}>
            {state.view?.moved === undefined ? t('neverSynced') : t('lastSync', { at: whenText(state.view.moved) })}
          </span>
        </div>
        {/*
          * All six sync actions are text buttons. The colour, not a frame, says
          * what each one costs: the sync itself takes the action colour, the two
          * that replace one whole side take the warning colour, and the ones that
          * only read (`check`, `preview`) or put something back (`undo`) stay in
          * the ordinary label colour. `ghost` gives them the hover fill and the
          * focus ring; `.textAction` is what keeps them on one line.
          */}
        <div className={css.footer}>
          <Button variant="ghost" size="sm" className={css.textAction} disabled={busy} onClick={() => props.check()}>
            {state.busy === 'check' ? t('working') : t('check')}
          </Button>
          <Button variant="ghost" size="sm" className={css.textAction} disabled={busy} onClick={() => props.preview()}>
            {state.busy === 'preview' ? t('working') : t('preview')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={`${css.textAction} ${css.textActionPrimary}`}
            disabled={busy}
            onClick={() => props.sync()}
          >
            {state.busy === 'sync' ? t('working') : t('syncNow')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={`${css.textAction} ${css.textActionReplace}`}
            disabled={busy}
            onClick={() => props.askRestore()}
          >
            {t('restore')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={css.textAction}
            disabled={busy || !(state.view?.undoable ?? false)}
            onClick={() => props.undo()}
          >
            {t('undo')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={`${css.textAction} ${css.textActionReplace}`}
            disabled={busy}
            onClick={() => props.askUpload()}
          >
            {t('upload')}
          </Button>
        </div>

        {/*
          * Everything one action has to say, read in the order it arrives: what
          * the host noticed, what it left behind, what still wants doing, the log
          * of an install, what a sync would do, the outcome sentence, the question
          * that has to be answered, and the one word that says work is running.
          *
          * These belong to the row of actions right above them rather than lower
          * down the card: a preview or a confirmation is the answer to one of
          * those buttons, and read from under another section's heading — with
          * the buttons that produced it out of sight, or even behind the manual
          * backup section — it looks like a standing setting of that section.
          * They are one column of their own so the eight blocks keep one gap
          * between them instead of each having to carry its own top margin, and
          * so the section's own rhythm (head, rows, actions) is untouched by
          * however many of them happen to be on screen at once.
          */}
        <div className={css.prompts}>
          {state.view?.notice !== undefined && (
            <div className={css.notice}>
              <span className={css.noticeTitle}>{t('noticeTitle')}</span>
              {state.view.notice.restored === true && <span>{t('noticeRestored')}</span>}
              {state.view.notice.here.length > 0 && (
                <span>{t('noticeHere', { parts: state.view.notice.here.map((part) => t(PART_NAME[part])).join('、') })}</span>
              )}
              {state.view.notice.there.length > 0 && (
                <span>{t('noticeThere', { parts: state.view.notice.there.map((part) => t(PART_NAME[part])).join('、') })}</span>
              )}
              {state.view.notice.saved !== undefined && <span>{t('noticeSaved', { dir: state.view.notice.saved })}</span>}
              <div>
                <Button variant="outline" size="sm" onClick={() => props.dismiss()}>{t('noticeDismiss')}</Button>
              </div>
            </div>
          )}

          {state.reloadNeeded && (
            <div className={css.promptRow}>
              <p className={css.note} role="status">{t('reloadHint')}</p>
              {/* The note outlives the action that set it on purpose — the disk has
                * really changed — but a note the person has read (or reloaded
                * around) should still come down when they say so. */}
              <PromptClose t={t} onClick={() => props.closeReload()} />
            </div>
          )}

          {state.view?.pendingInstall === true && (
            <div className={css.note} role="status">
              <div className={css.promptRow}>
                <span>{t('pendingInstall', { names: (state.view.pendingNames ?? []).join('、') })}</span>
                {/* Taken down on the host, by signature: the exact list of names on
                  * screen is what is remembered, so a different plugin arriving
                  * signs differently and the card says it again — while a hint
                  * about plugins that are in fact installed can be put away. */}
                <PromptClose
                  t={t}
                  disabled={busy}
                  onClick={() => props.dismissPrompt('pending-install', signatureOf(state.view?.pendingNames ?? []))}
                />
              </div>{' '}
              <Button variant="outline" size="sm" disabled={busy} onClick={() => props.install()}>
                {t('pendingInstallAction')}
              </Button>
            </div>
          )}

          {state.installOutput !== '' && (
            <div className={css.outputBlock}>
              <div className={css.outputHead}>
                <span className={state.installFailed ? css.failed : css.note}>
                  {state.installFailed ? t('installFailed') : t('installOk')}
                </span>
                <Button variant="outline" size="sm" onClick={() => props.closeOutput()}>
                  {t('outputClose')}
                </Button>
              </div>
              <pre className={css.output}>{state.installOutput}</pre>
            </div>
          )}

          {state.preview !== undefined && (
            <div className={css.previewBlock}>
              <div className={css.outputHead}>
                <h5 className={css.previewTitle}>{t('previewTitle')}</h5>
                {/* The empty answer (「两边一致，同步不会有任何改动。」) is exactly the
                  * kind of line that has nowhere to go once read: it names no
                  * change, so it takes the ✕ rather than waiting for the next
                  * action to replace it. */}
                <PromptClose t={t} onClick={() => props.closePreview()} />
              </div>
              {state.preview.changes.length === 0 ? (
                <p className={css.hint}>{t('previewEmpty')}</p>
              ) : (
                <div className={css.previewList}>
                  {state.preview.changes.map((change) => (
                    <div className={css.previewRow} key={change.part}>
                      <span className={css.previewPart}>{t(PART_NAME[change.part])}</span>
                      <span>
                        {change.take === 'local'
                          ? t('takeLocal')
                          : change.take === 'remote'
                            ? t('takeRemote')
                            : change.take === 'newer-local'
                              ? t('takeNewerLocal')
                              : t('takeNewerRemote')}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {state.message !== '' && (
            <div className={css.promptRow}>
              <p className={state.messageFailed ? css.failed : css.note} role={state.messageFailed ? 'alert' : 'status'}>
                {state.message}
              </p>
              <PromptClose t={t} onClick={() => props.closeMessage()} />
            </div>
          )}

          {confirmText !== '' && (
            <div className={css.confirm}>
              <span>{confirmText}</span>
              <Button variant="primary" size="sm" disabled={busy} onClick={() => props.answer(true)}>{t('yes')}</Button>
              <Button variant="outline" size="sm" onClick={() => props.answer(false)}>{t('no')}</Button>
            </div>
          )}

          {busy && busyKey !== undefined && (
            <p className={css.note} role="status">
              <Tag tone="quiet">{t(busyKey)}</Tag> {t('working')}
            </p>
          )}
        </div>
      </section>

      <ManualBackupPanel
        {...props}
        t={t}
        state={state}
        busy={busy}
        partName={(part) => t(PART_NAME[part])}
      />

      {/*
        * The forwarder, as the last section of this form and under this Save.
        *
        * It is a switch on the configuration above rather than a second one: the
        * address it forwards to, the account it signs in with and the extra
        * headers are the ones already filled in here, and the account it hands
        * out is the one thing about it that is its own. It sits last because it
        * is the least often touched, and inside the form because a second Save
        * would be a second thing to forget.
        */}
      <RelayPanel
        t={t}
        target={state.url}
        enabled={state.relayEnabled}
        port={state.relayPort}
        view={state.view?.relay}
        busy={busy}
        onToggle={(next) => props.toggle('relayEnabled', next)}
        onNextPort={() => props.nextPort()}
      />

      {/* The sync's own two buttons close the card, forwarder and all. */}
      <div className={css.cardFooter}>
        <span className={css.hint}>{t('saveLegend')}</span>
        <span className={css.spacer} />
        <Button variant="outline" size="sm" disabled={busy || !state.dirty} onClick={() => props.reset()}>
          {t('discard')}
        </Button>
        <Button variant="primary" size="sm" disabled={busy || !state.dirty} onClick={() => props.save()}>
          {state.busy === 'save' ? t('saving') : t('save')}
        </Button>
      </div>
    </div>
  )
}

/**
 * The card on the Plugins page: one line on the bundle's row, the form on its page.
 *
 * @param props - the card snapshot, its actions, and the page's `view`.
 * @returns the summary line or the form.
 */
export function WebdavSyncBundleCard(props: WebdavSyncBundleProps) {
  return <Card {...props} view={props.view} />
}

/**
 * The card as a Settings page. There is no summary seat here, so the form always renders.
 *
 * @param props - the card snapshot and its actions.
 * @returns the form.
 */
export function WebdavSyncSection(props: WebdavSyncSectionProps) {
  return <Card {...props} view="page" />
}
