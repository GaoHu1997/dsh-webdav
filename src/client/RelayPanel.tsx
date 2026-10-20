/**
 * The forwarder's section of the card.
 *
 * It is a section of the sync's own form, not a panel of its own: one switch, and
 * — once it is on — the one address another program is pointed at, in a text box
 * with a copy button, and the account that address asks for underneath it.
 * Nothing here is filled in and nothing here is saved separately: everything the
 * forwarder uses is the configuration above it, and the account is generated.
 *
 * The address is worked out from the draft rather than from what the host last
 * reported, so the box shows the address this configuration *will* hand out,
 * following the address above as it is edited. What the host is actually running
 * comes from the view: whether it is listening, why it is not, and the account it
 * minted, which does not exist until the first save. The port is part of the
 * address rather than a field of its own — a reader copies one string, and the
 * one case where the port needs changing (some other program already holds it)
 * is exactly the case where the host reports it.
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

/** Whether the last copy reached the clipboard. */
type Copied = boolean | undefined

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
  const problem = view?.error ?? ''

  const copy = (text: string): void => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(text)
        setCopied(true)
      } catch {
        setCopied(false)
      }
    })()
  }

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

      <div className={css.relaySwitch}>
        <Checkbox
          checked={enabled}
          label={t('relayEnable')}
          disabled={busy}
          onChange={(next) => props.onToggle(next)}
        />
      </div>

      {enabled && (
        <>
          {target.trim() === '' ? (
            <p className={css.hint}>{t('relayNoTarget')}</p>
          ) : (
            <div className={css.relayAddressRow}>
              {/*
                * A plain input rather than the primitive: this one is not a field
                * anybody types in, it is a value to be read and copied, and it
                * wants the whole line. The card's own frame keeps it looking like
                * the fields above it.
                */}
              <input
                className={css.relayAddress}
                value={address}
                readOnly
                spellCheck={false}
                aria-label={t('relayLegend')}
              />
              <Button variant="outline" size="sm" onClick={() => copy(address)}>
                {t('relayCopy')}
              </Button>
              {copied !== undefined && (
                <span className={css.hint}>{copied ? t('relayCopied') : t('relayCopyFailed')}</span>
              )}
            </div>
          )}

          {problem !== '' && (
            <div className={css.relayAddressRow}>
              <span className={css.failed} role="alert">{problem}</span>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => props.onNextPort()}>
                {t('relayNextPort')}
              </Button>
            </div>
          )}

          {account === '' ? (
            <p className={css.hint}>{t('relayAccountLater')}</p>
          ) : (
            <div className={css.relayAccountRow}>
              <span className={css.relayLabel}>{t('relayUserLabel')}</span>
              <span className={css.relayValue}>{account}</span>
              <span className={css.relayLabel}>{t('relayPasswordLabel')}</span>
              <span className={css.relayValue}>{password}</span>
            </div>
          )}
        </>
      )}
    </section>
  )
}
