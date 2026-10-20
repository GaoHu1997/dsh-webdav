import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayPanel, type RelayPanelProps } from '../src/client/RelayPanel.tsx'
import { RELAY_DEFAULT_PORT, type RelayView } from '../src/wire.ts'

vi.mock('../src/client/WebdavSyncCard.module.css', () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement, Fragment } = await import('react')
  const Button = ({ children, icon, variant, size, ...props }: { children?: ReactNode; icon?: ReactNode; variant?: string; size?: string; [key: string]: unknown }) =>
    createElement('button', props, icon, children)
  const Checkbox = ({ checked, label, onChange, ...props }: { checked: boolean; label: string; onChange?: (next: boolean) => void; [key: string]: unknown }) =>
    createElement('label', props, createElement('input', { type: 'checkbox', checked, readOnly: true, onChange: () => onChange?.(!checked) }), label)
  const Tag = ({ children }: { children?: ReactNode }) => createElement('span', null, children)
  // The bubble is an overlay around its anchor: the anchor alone is what this suite reads.
  const Tooltip = ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children)
  const IconCopyOutlineRegular = () => createElement('span', { className: 'copy-icon' })
  const IconCheckOutlineRegular = () => createElement('span', { className: 'check-icon' })
  const writeClipboard = vi.fn(async () => true)
  return { Button, Checkbox, IconCheckOutlineRegular, IconCopyOutlineRegular, Tag, Tooltip, writeClipboard }
})

const text: Record<string, string> = {
  relayLegend: 'Local relay',
  relayEnable: 'Enable relay',
  relayListening: 'Listening',
  relayIdle: 'Idle',
  relayNoTarget: 'No target',
  relayNextPort: 'Change port',
  relayAccountLater: 'Save to generate account',
  relayUserLabel: 'Username',
  relayPasswordLabel: 'Password',
  relayCopy: 'Copy',
  relayCopied: 'Copied',
  relayCopyFailed: 'Copy failed',
}

const t = (key: string): string => text[key] ?? key

const view = (over: Partial<RelayView> = {}): RelayView => ({
  enabled: true,
  port: RELAY_DEFAULT_PORT,
  url: `http://127.0.0.1:${RELAY_DEFAULT_PORT}/dav`,
  user: 'dsh-test-user',
  password: 'test-password',
  listening: true,
  error: '',
  ...over,
})

function render(over: Partial<RelayPanelProps> = {}): string {
  const props: RelayPanelProps = {
    t,
    target: 'https://dav.test/dav/',
    enabled: false,
    port: RELAY_DEFAULT_PORT,
    view: undefined,
    busy: false,
    onToggle: vi.fn(),
    onNextPort: vi.fn(),
    ...over,
  }
  return renderToStaticMarkup(<RelayPanel {...props} />)
}

describe('RelayPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('does not render an address or an account while the relay is off', () => {
    const html = render({ view: view() })

    expect(html).not.toContain('http://127.0.0.1')
    expect(html).not.toContain('Username')
    expect(html).not.toContain('Password')
    expect(html).not.toContain('Copy')
    expect(html).not.toContain('copy-icon')
  })

  it('shows the draft address as text with the copy icon right after it, and waits to generate an account until save', () => {
    const html = render({ enabled: true, view: view({ user: '', password: '' }) })

    expect(html).toContain('>http://127.0.0.1:3426/dav</code>')
    expect(html).toContain('copy-icon')
    expect(html.match(/aria-label="Copy"/g)).toHaveLength(1)
    expect(html).not.toMatch(/value="http/)
    expect(html).toContain('Save to generate account')
    expect(html).not.toContain('dsh-test-user')
    expect(html).not.toContain('test-password')
    expect(html).not.toContain('>Save<')
  })

  it('shows the saved local account under the address, without a second copy button or a port field', () => {
    const html = render({ enabled: true, view: view() })

    expect(html).toContain('dsh-test-user')
    expect(html).toContain('test-password')
    expect(html.match(/aria-label="Copy"/g)).toHaveLength(1)
    expect(html).toContain('Local relay')
    expect(html).not.toContain('Port')
    expect(html).not.toContain('>Save<')
  })

  it('does not claim the relay is listening when the draft port differs', () => {
    const html = render({ enabled: true, port: RELAY_DEFAULT_PORT + 1, view: view() })

    expect(html).toContain('3427')
    expect(html).toContain('Idle')
    expect(html).not.toContain('Listening')
  })

  it('shows a host relay error beside the only port control there is', () => {
    const html = render({ enabled: true, view: view({ error: 'port is already in use' }) })

    expect(html).toContain('port is already in use')
    expect(html).toContain('Change port')
  })

  it('keeps the port control away when nothing went wrong', () => {
    const html = render({ enabled: true, view: view() })

    expect(html).not.toContain('Change port')
  })
})
