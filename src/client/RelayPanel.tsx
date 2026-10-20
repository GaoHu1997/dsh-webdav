/**
 * The relay's own panel: the fifth section of the card, and the only part of it
 * that is not about syncing.
 *
 * It is drawn as a box of its own because it *is* one — a different feature,
 * a different file, a different pair of routes, and its own Save. The address it
 * shows is the thing a user comes here for, so it is set in mono and given a
 * copy button rather than buried in prose.
 *
 * @module webdav-sync/client/RelayPanel
 */

import { useState } from 'react'
import { Button, Checkbox, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RelayActions, RelayState } from './relay-store.ts'
import { RELAY_DEFAULT_PORT } from '../wire.ts'
import type { WebdavSyncKey } from './locales.ts'
import css from './WebdavSyncCard.module.css'

/** What the panel needs from the card that hosts it. */
export interface RelayPanelProps {
  /** The bound dictionary lookup. */
  t: (key: WebdavSyncKey, params?: Record<string, unknown>) => string
  /** The relay store's snapshot. */
  state: RelayState
  /** The relay store's actions. */
  relay: RelayActions
}

/**
 * The relay section.
 *
 * @param props - the snapshot, the actions and the dictionary.
 * @returns the section, or nothing at all while the first read is in flight.
 */
export function RelayPanel(props: RelayPanelProps) {
  const { t, state, relay } = props
  const [copied, setCopied] = useState<'' | 'ok' | 'no'>('')
  const view = state.view
  const busy = state.busy !== ''
  const address = view?.url ?? ''

  const copy = (): void => {
    void navigator.clipboard
      .writeText(address)
      .then(() => setCopied('ok'))
      .catch(() => setCopied('no'))
  }

  return (
    <section className={css.relayBox}>
      <div className={css.relayHead}>
        <h4 className={`${css.legend} ${css.relayLegend}`}>{t('relayLegend')}</h4>
        <Tag tone={view?.listening === true ? 'success' : 'quiet'}>
          {view?.listening === true ? t('relayActive') : t('relayIdle')}
        </Tag>
      </div>
      <p className={css.fieldHint}>{t('relayHint')}</p>

      <div className={css.relaySwitch}>
        <Checkbox
          checked={state.enabled}
          label={t('relayEnable')}
          disabled={busy}
          onChange={(next) => relay.toggle(next)}
        />
      </div>

      <div className={css.grid}>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="webdav-relay-target">{t('relayTargetLabel')}</label>
          <Input
            id="webdav-relay-target"
            value={state.target}
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            placeholder={t('relayTargetPlaceholder')}
            onChange={(event) => relay.edit('target', event.target.value)}
          />
        </div>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="webdav-relay-port">{t('relayPortLabel')}</label>
          <Input
            id="webdav-relay-port"
            value={state.port}
            inputMode="numeric"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            placeholder={String(RELAY_DEFAULT_PORT)}
            onChange={(event) => relay.edit('port', event.target.value)}
          />
          <p className={css.fieldHint}>{t('relayPortHint')}</p>
        </div>
      </div>

      <div className={css.field}>
        <label className={css.fieldLabel} htmlFor="webdav-relay-headers">{t('relayHeadersLabel')}</label>
        <textarea
          id="webdav-relay-headers"
          className={css.headersArea}
          rows={3}
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
          placeholder={t('headersPlaceholder')}
          value={state.headers}
          onChange={(event) => relay.edit('headers', event.target.value)}
        />
      </div>

      <div className={css.field}>
        <span className={css.fieldLabel}>{t('relayAddressLabel')}</span>
        {address === '' ? (
          <p className={css.fieldHint}>{t('relayAddressEmpty')}</p>
        ) : (
          <div className={css.addressRow}>
            <span className={css.address} title={address}>{address}</span>
            <Button variant="outline" size="sm" onClick={copy}>{t('relayCopy')}</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => relay.regenerate()}>
              {t('relayNewAddress')}
            </Button>
            {copied === 'ok' && <span className={css.hint}>{t('relayCopied')}</span>}
            {copied === 'no' && <span className={css.failed}>{t('relayCopyFailed')}</span>}
          </div>
        )}
        <p className={css.fieldHint}>{t('relayNewAddressHint')}</p>
      </div>

      {view !== undefined && view.error !== '' && (
        <p className={css.failed} role="alert">{view.error}</p>
      )}
      {state.problem !== '' && <p className={css.failed} role="alert">{t('relayPortBad')}</p>}
      {state.message !== '' && (
        <p className={state.messageFailed ? css.failed : css.note} role={state.messageFailed ? 'alert' : 'status'}>
          {state.message}
        </p>
      )}
      {view !== undefined && <p className={css.relayFile}>{t('relayFile', { file: view.file })}</p>}

      <div className={css.cardFooter}>
        <span className={css.hint}>{t('relaySaveLegend')}</span>
        <span className={css.spacer} />
        <Button variant="outline" size="sm" disabled={busy || !state.dirty} onClick={() => relay.reset()}>
          {t('discard')}
        </Button>
        <Button variant="primary" size="sm" disabled={busy || !state.dirty} onClick={() => relay.save()}>
          {busy ? t('saving') : t('save')}
        </Button>
      </div>
    </section>
  )
}
