/**
 * The forwarder's section of the card.
 *
 * It is a section of the sync's own form, not a panel of its own: one switch, and
 * — once it is on — the one address another program is pointed at, as plain text
 * with a copy icon right after it, and the account that address asks for
 * underneath it, each of its two values carrying the same copy icon. Nothing here
 * is filled in and nothing here is saved separately: everything the forwarder uses
 * is the configuration above it, and the account is generated.
 *
 * The address is worked out from the draft rather than from what the host last
 * reported, so the line shows the address this configuration *will* hand out,
 * following the address above as it is edited. What the host is actually running
 * comes from the view: whether it is listening, why it is not, and the account it
 * minted, which does not exist until the first save. The port is part of the
 * address rather than a field of its own — a reader copies one string, and the
 * one case where the port needs changing (some other program already holds it)
 * is exactly the case where the host reports it.
 *
 * @module webdav-sync/client/RelayPanel
 */

import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Checkbox,
  IconCheckOutlineRegular,
  IconCopyOutlineRegular,
  Tag,
  Tooltip,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
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

/** Which of the three values a reader can copy. */
type CopyTarget = 'address' | 'user' | 'password'

/** What the last copy did, and to which value. */
type Copied = { target: CopyTarget; ok: boolean } | undefined

/** How long a copy icon says it worked, matching the app's own copy buttons. */
const COPIED_MS = 1_000

/** The props of one copy icon: which value it takes, and what it is called. */
interface CopyControlProps {
  /** The tooltip and the accessible name, e.g. 「复制地址」. */
  label: string
  /** Whether this very value is the one that was just copied. */
  done: boolean
  /** Take the value. */
  onCopy: () => void
}

/**
 * One copy icon: a ghost button whose glyph changes to a check for a moment.
 *
 * @param props - the label, whether it worked, and the write to run.
 * @returns the button, with its tooltip.
 */
function CopyControl({ label, done, onCopy }: CopyControlProps) {
  return (
    <Tooltip label={label} side="top" portal>
      <Button
        variant="ghost"
        size="sm"
        className={css.relayCopy}
        icon={done ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
        aria-label={label}
        onClick={onCopy}
      />
    </Tooltip>
  )
}

/**
 * The forwarder section.
 *
 * @param props - the draft's switch and port, the host's view, and the dictionary.
 * @returns the section.
 */
export function RelayPanel(props: RelayPanelProps) {
  const { t, target, enabled, port, view, busy } = props
  const [copied, setCopied] = useState<Copied>(undefined)
  const revert = useRef<number | undefined>(undefined)

  const address = relayUrl(port, relayBasePath(target))
  const account = view?.user ?? ''
  const password = view?.password ?? ''
  const listening = view?.listening === true && view.port === port && view.url === address
  const problem = view?.error ?? ''

  // The check is on a timer, so unmounting with one pending must not write to a gone component.
  useEffect(() => () => window.clearTimeout(revert.current), [])

  const copy = (which: CopyTarget, text: string): void => {
    void writeClipboard(text).then((ok) => {
      setCopied({ target: which, ok })
      window.clearTimeout(revert.current)
      // A refused write stays on screen; a write that worked is old news in a second.
      if (ok) revert.current = window.setTimeout(() => setCopied(undefined), COPIED_MS)
    })
  }

  /** One value's copy icon, saying 「已复制」 for it and for nothing else. */
  const control = (which: CopyTarget, text: string, base: WebdavSyncKey) => {
    const done = copied?.target === which && copied.ok
    const failed = copied?.target === which && !copied.ok
    return (
      <>
        <CopyControl label={done ? t('relayCopied') : t(base)} done={done} onCopy={() => copy(which, text)} />
        {failed && (
          <span className={css.failed} role="alert">
            {t('relayCopyFailed')}
          </span>
        )}
      </>
    )
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
                * Named like the account values below it: 「地址」, then the
                * string, then what takes it away. Plain text rather than a
                * field — nobody types here. This is one string to be read and
                * handed to another program, the button right beside it is how it
                * leaves, and text keeps the fallback the failure hint asks for:
                * select it and copy by hand.
                */}
              <span className={css.relayLabel}>{t('relayAddressLabel')}</span>
              <code className={css.relayAddress}>{address}</code>
              {control('address', address, 'relayCopyAddress')}
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
              {/* Each pair stays together when the card is too narrow for both. */}
              <span className={css.relayPair}>
                <span className={css.relayLabel}>{t('relayUserLabel')}</span>
                <span className={css.relayValue}>{account}</span>
                {control('user', account, 'relayCopyUser')}
              </span>
              <span className={css.relayPair}>
                <span className={css.relayLabel}>{t('relayPasswordLabel')}</span>
                <span className={css.relayValue}>{password}</span>
                {control('password', password, 'relayCopyPassword')}
              </span>
            </div>
          )}
        </>
      )}
    </section>
  )
}
