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
import { Button, Checkbox, Input, SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { AUTO_CHOICES, AUTO_MANUAL, DIRS_MAX, type Part, type PartView } from '../wire.ts'
import type { CardActions, CardBusy, CardStore, ToggleField } from './card-store.ts'
import { RelayPanel } from './RelayPanel.tsx'
import { NS, type WebdavSyncKey } from './locales.ts'
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
  defaults: 'partDefaults',
  plugins: 'partPlugins',
  patch: 'partPatch',
  dirs: 'partDirs',
}

/** Which dictionary key says, in a line, what a part carries. */
const PART_HINT: Record<Part, WebdavSyncKey> = {
  models: 'partModelsHint',
  defaults: 'partDefaultsHint',
  plugins: 'partPluginsHint',
  patch: 'partPatchHint',
  dirs: 'partDirsHint',
}

/**
 * The parts whose switch is a checkbox on their own row.
 *
 * The extra directories are a `part` too — they hash, merge and travel like the
 * four profile parts — but there is no single boolean behind them: the list
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
 * How often the card re-reads the status while it is open, in milliseconds.
 *
 * The host's own timer works in minutes, so anything in that range would do;
 * this is small enough that a page left open shows a sync as soon as it happens
 * and large enough that the host is not being asked constantly. Nothing here
 * reaches the server: `status` reads the profile and the state file.
 */
const STATUS_EVERY_MS = 15_000

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

  useEffect(() => {
    if (onPage) props.ensure()
    // `ensure` is latched, so a re-run costs nothing; the dependency list stays
    // on `onPage` because the props object is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onPage])

  // The times below are the host's, and the host's timer works in minutes while
  // this page sits open for far longer: without a read of its own the card would
  // keep showing what it opened with, so a sync running perfectly on time looked
  // exactly like one that had stopped. Every few seconds is enough for that, and
  // it costs no request to the server — `status` reads files only. The bundle row
  // shows no times and is left alone, and a read still in flight when the card
  // goes away is discarded with it.
  useEffect(() => {
    if (!onPage) return undefined
    const timer = setInterval(() => props.poll(), STATUS_EVERY_MS)
    return () => clearInterval(timer)
    // `poll` is rebuilt on every render like the rest of the props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onPage])

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
          <Button variant="outline" size="sm" onClick={() => props.refresh()}>{t('check')}</Button>
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
      {state.error !== '' && <p className={css.failed} role="alert">{state.error}</p>}

      <section>
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

      <section>
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

      <section>
        <h4 className={css.legend}>{t('partsLegend')}</h4>
        {(state.view?.parts ?? []).filter(isToggledPart).map((part) => {
          const stateKey: WebdavSyncKey = part.synced ? partStateKey(part) : 'partOff'
          return (
            <div className={css.partRow} key={part.part}>
              <span className={css.partText}>
                <Checkbox
                  checked={part.synced}
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
                {t(dirsPart.synced ? partStateKey(dirsPart) : 'partOff')}
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
        <div className={css.footer}>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => props.check()}>
            {state.busy === 'check' ? t('working') : t('check')}
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => props.preview()}>
            {state.busy === 'preview' ? t('working') : t('preview')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={css.syncAction}
            disabled={busy}
            onClick={() => props.sync()}
          >
            {state.busy === 'sync' ? t('working') : t('syncNow')}
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => props.askRestore()}>
            {t('restore')}
          </Button>
          <Button variant="outline" size="sm" disabled={busy || !(state.view?.undoable ?? false)} onClick={() => props.undo()}>
            {t('undo')}
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => props.askUpload()}>
            {t('upload')}
          </Button>
        </div>
      </section>

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

      {state.reloadNeeded && <p className={css.note} role="status">{t('reloadHint')}</p>}

      {state.view?.pendingInstall === true && (
        <div className={css.note} role="status">
          <span>{t('pendingInstall', { names: (state.view.pendingNames ?? []).join('、') })}</span>{' '}
          <Button variant="outline" size="sm" disabled={busy} onClick={() => props.install()}>
            {t('pendingInstallAction')}
          </Button>
        </div>
      )}

      {state.installOutput !== '' && (
        <>
          <p className={state.messageFailed ? css.failed : css.note}>
            {state.messageFailed ? t('installFailed') : t('installOk')}
          </p>
          <pre className={css.output}>{state.installOutput}</pre>
        </>
      )}

      {state.preview !== undefined && (
        <section>
          <h4 className={css.legend}>{t('previewTitle')}</h4>
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
        </section>
      )}

      {state.message !== '' && (
        <p className={state.messageFailed ? css.failed : css.note} role={state.messageFailed ? 'alert' : 'status'}>
          {state.message}
        </p>
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
