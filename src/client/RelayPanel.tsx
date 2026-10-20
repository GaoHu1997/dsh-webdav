/**
 * The forwarder's section of the card.
 *
 * It is a section of the sync's own form, not a panel of its own: one switch, and
 * — once it is on — the address and account another program is configured with,
 * in small text under the switch. There is nothing to fill in and nothing to save
 * separately, because everything it forwards with is already configured above it;
 * the one thing it owns is the account, and that is generated.
 *
 * The address is worked out from the draft rather than from what the host last
 * reported, so the line shows the address this configuration *will* hand out,
 * updating as the address above it is edited. What the host is actually running
 * comes from the view: whether it is listening, why it is not, and the account it
 * minted, which does not exist until the first save.
 *
 * @module webdav-sync/client/RelayPanel
 */

import { useState } from 'react'
import { Button, Checkbox, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { relayBasePath, relayUrl, type RelayView } from '../wire.ts'
import type { WebdavSyncKey } from './locales.ts'
import css from './WebdavSyncCard.module.css'

/** What the section needs from the card that hosts it. */
export interface RelayPanelProps {
  /** The bound dictionary lookup. */
  t: (key: WebdavSyncKey, params?: Record<string, unknown>) => string
  /** The WebDAV address being configured, which the forwarded address is derived from. */
  target: string
  /** The draft's switch. */
  enabled: boolean
  /** The draft's port. */
  port: number
  /** What the host says about the forwarder it is running. */
  view: RelayView | undefined
  /** Whether a write is in flight, which disables the switch. */
  busy: boolean
  /** Turn the draft's switch. */
  onToggle: (next: boolean) => void
  /** Move the draft's port up by one, for a port already taken. */
  onNextPort: () => void
}

/** Which of the three things on the line was last copied, with whether it worked. */
type Copied = { what: string; ok: boolean } | undefined

/**
 * The forwarder section.
 *
 * @param props - the draft's switch and port, the host's view, and the dictionary.
 * @returns the section.
 */
export function RelayPanel(props: RelayPanelProps) {
  const { t, target, enabled, port, view, busy } = props
  const [copied, setCopied] = useState<Copied>(undefined)

  const address = relayUrl(port, relayBasePath(target))
  const account = view?.user ?? ''
  const password = view?.password ?? ''
  const listening = view?.listening === true && view.port === port && view.url === address

  const copy = (what: string, text: string): void => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(text)
        setCopied({ what, ok: true })
      } catch {
        setCopied({ what, ok: false })
      }
    })()
  }

  const state = (what: string) => (copied?.what === what ? (copied.ok ? t('relayCopied') : t('relayCopyFailed')) : '')

  return (
    <section>
      <h4 className={css.legend}>
        {t('relayLegend')}
        {enabled && (
          <Tag tone={listening ? 'success' : 'quiet'}>
            {listening ? t('relayListening') : t('relayIdle')}
          </Tag>
        )}
      </h4>
      <p className={css.fieldHint}>{t('relayHint')}</p>

      <div className={css.field}>
        <Checkbox
          checked={enabled}
          label={t('relayEnable')}
          disabled={busy}
          onChange={(next) => props.onToggle(next)}
        />
      </div>

      {enabled && (
        <>
          <div className={css.relayLine}>
            <span className={css.relayLabel}>{t('relayAddressLabel')}</span>
            {target.trim() === '' ? (
              <span className={css.relayLabel}>{t('relayNoTarget')}</span>
            ) : (
              <>
                <span className={css.address} title={address}>{address}</span>
                <Button variant="outline" size="sm" onClick={() => copy('address', address)}>
                  {t('relayCopy')}
                </Button>
                {state('address') !== '' && <span className={css.hint}>{state('address')}</span>}
              </>
            )}
          </div>

          <div className={css.relayLine}>
            <span className={css.relayLabel}>{t('relayPortLabel')}</span>
            <span className={css.relayValue}>{port}</span>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => props.onNextPort()}>
              {t('relayNextPort')}
            </Button>
            <span className={css.relayLabel}>{t('relayAccountHint')}</span>
          </div>

          {account === '' ? (
            <p className={css.fieldHint}>{t('relayAccountLater')}</p>
          ) : (
            <>
              <div className={css.relayLine}>
                <span className={css.relayLabel}>{t('relayUserLabel')}</span>
                <span className={css.relayValue}>{account}</span>
                <Button variant="outline" size="sm" onClick={() => copy('user', account)}>
                  {t('relayCopy')}
                </Button>
                {state('user') !== '' && <span className={css.hint}>{state('user')}</span>}
              </div>
              <div className={css.relayLine}>
                <span className={css.relayLabel}>{t('relayPasswordLabel')}</span>
                <span className={css.relayValue}>{password}</span>
                <Button variant="outline" size="sm" onClick={() => copy('password', password)}>
                  {t('relayCopy')}
                </Button>
                {state('password') !== '' && <span className={css.hint}>{state('password')}</span>}
              </div>
            </>
          )}

          {view !== undefined && view.error !== '' && (
            <p className={css.failed} role="alert">{view.error}</p>
          )}
        </>
      )}
    </section>
  )
}
