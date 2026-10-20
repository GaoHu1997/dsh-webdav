import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayPanel, type RelayPanelProps } from '../src/client/RelayPanel.tsx'
import { RELAY_DEFAULT_PORT, type RelayView } from '../src/wire.ts'

vi.mock('../src/client/WebdavSyncCard.module.css', () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement } = await import('react')
  const Button = ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement('button', props, children)
  const Checkbox = ({ checked, label, onChange, ...props }: { checked: boolean; label: string; onChange?: (next: boolean) => void; [key: string]: unknown }) =>
    createElement('label', props, createElement('input', { type: 'checkbox', checked, readOnly: true, onChange: () => onChange?.(!checked) }), label)
  const Tag = ({ children }: { children?: ReactNode }) => createElement('span', null, children)
  return { Button, Checkbox, Tag }
})

const text: Record<string, string> = {
  relayLegend: 'Local relay',
  relayHint: 'Relay hint',
  relayEnable: 'Enable relay',
  relayListening: 'Listening',
  relayIdle: 'Idle',
  relayAddressLabel: 'Address',
  relayNoTarget: 'No target',
  relayPortLabel: 'Port',
  relayNextPort: 'Change port',
  relayAccountHint: 'Relay account',
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

  it('does not render an account row while the relay is off', () => {
    const html = render({ view: view() })

    expect(html).not.toContain('Username')
    expect(html).not.toContain('Password')
    expect(html).not.toContain('Copy')
  })

  it('shows the draft address and port, but waits to generate an account until save', () => {
    const html = render({ enabled: true, view: view({ user: '', password: '' }) })

    expect(html).toContain('http://127.0.0.1:3426/dav')
    expect(html).toContain('3426')
    expect(html).toContain('Save to generate account')
    expect(html).not.toContain('dsh-test-user')
    expect(html).not.toContain('test-password')
    expect(html).not.toContain('>Save<')
  })

  it('shows saved local credentials with copy buttons and no target/header inputs or extra Save', () => {
    const html = render({ enabled: true, view: view() })

    expect(html).toContain('dsh-test-user')
    expect(html).toContain('test-password')
    expect(html.match(/>Copy<\/button>/g)).toHaveLength(3)
    expect(html).not.toContain('WebDAV')
    expect(html).not.toContain('headers')
    expect(html).not.toContain('>Save<')
  })

  it('does not claim the relay is listening when the draft port differs', () => {
    const html = render({ enabled: true, port: RELAY_DEFAULT_PORT + 1, view: view() })

    expect(html).toContain('3427')
    expect(html).toContain('Idle')
    expect(html).not.toContain('Listening')
  })

  it('shows a host relay error', () => {
    const html = render({ enabled: true, view: view({ error: 'port is already in use' }) })

    expect(html).toContain('port is already in use')
  })
})
