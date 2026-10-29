import React, { type ReactNode } from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebdavSyncCard, type CardState } from '../src/client/card-store.ts'
import { zh } from '../src/client/locales.ts'
import { WebdavSyncBundleCard, WebdavSyncSection, type WebdavSyncSectionProps } from '../src/client/WebdavSyncCard.tsx'
import { PARTS, RELAY_DEFAULT_PORT, type ConfigView, type StatusResult } from '../src/wire.ts'

vi.mock('../src/client/WebdavSyncCard.module.css', () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))

// Match the primitives' relevant DOM: Checkbox owns a label, Input wraps its
// input, and Button wraps its SVG. No browser/layout dependency is required.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement, Fragment } = await import('react')
  const Button = ({ children, icon, variant, size, ...props }: { children?: ReactNode; icon?: ReactNode; variant?: string; size?: string; [key: string]: unknown }) =>
    createElement('button', props, icon && createElement('span', { className: 'primitive-icon' }, icon), children)
  const Checkbox = ({ checked, label, onChange, ...props }: { checked: boolean; label: ReactNode; onChange?: (next: boolean) => void; [key: string]: unknown }) =>
    createElement('label', props, createElement('input', { type: 'checkbox', checked, readOnly: true }), label)
  const Input = (props: Record<string, unknown>) => createElement('span', { className: 'primitive-wrap' }, createElement('input', props))
  const SegmentedControl = ({ id, label }: { id?: string; label?: string }) => createElement('div', { id, role: 'tablist', 'aria-label': label })
  const Tag = ({ children }: { children?: ReactNode }) => createElement('span', null, children)
  const Tooltip = ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children)
  const Icon = () => createElement('svg', { width: 24, height: 24, 'aria-hidden': true })
  return { Button, Checkbox, Input, SegmentedControl, Tag, Tooltip, IconRefreshOutlineRegular: Icon, IconCopyOutlineRegular: Icon, IconCheckOutlineRegular: Icon, IconCloseOutlineRegular: Icon, writeClipboard: vi.fn(async () => true) }
})

const config: ConfigView = {
  url: 'https://dav.test/dav', user: 'me', passwordSet: true, passphraseSet: true,
  autoEvery: -1, models: true, plugins: true, patch: true, keys: true, dirs: [],
  dirsEnabled: false, rememberPassword: true, headers: '', relayEnabled: true, relayPort: RELAY_DEFAULT_PORT,
}
const status: StatusResult = {
  configured: true, config, error: '', pendingInstall: false, undoable: false,
  paths: { profileDir: '/p', stateDir: '/p/.dsh-webdav-sync', patchFile: '/p/cordis.patch.yml', packageFile: '/p/package.json' },
  parts: PARTS.map((part) => ({ part, local: 'hash', remote: 'hash', localChanged: false, remoteChanged: false, synced: true })),
  relay: { enabled: true, port: RELAY_DEFAULT_PORT, url: `http://127.0.0.1:${RELAY_DEFAULT_PORT}/dav`, user: 'local-user', password: 'local-password', listening: true, error: '' },
}

async function render(overrides: Partial<CardState> = {}, view?: 'summary'): Promise<string> {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ...status, ok: true }), { status: 200 }))
  const card = new WebdavSyncCard()
  await card.load()
  const state = { ...card.getSnapshot(), ...overrides }
  const props = {
    ...card.actions(),
    t: (key: keyof typeof zh, params?: Record<string, unknown>) => zh[key].replace(/\{(\w+)\}/g, (whole, name: string) => params?.[name] === undefined ? whole : String(params[name])),
    useWebdavSync: (select: (value: CardState) => unknown) => select(state),
  } as unknown as WebdavSyncSectionProps
  return view === 'summary'
    ? renderToStaticMarkup(<WebdavSyncBundleCard {...(props as unknown as Parameters<typeof WebdavSyncBundleCard>[0])} view="summary" />)
    : renderToStaticMarkup(<WebdavSyncSection {...props} />)
}

type Rule = { selectors: string[]; declarations: Record<string, string>; media: string }
// Read individual selector/declaration pairs, including their media context.
// Formatting, comments, selector order and unrelated rules may change freely.
function parseRules(source: string, media = ''): Rule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const result: Rule[] = []
  let cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf('{', cursor)
    if (open < 0) break
    const prelude = text.slice(cursor, open).trim()
    let depth = 1
    let end = open + 1
    while (depth > 0 && end < text.length) {
      if (text[end] === '{') depth += 1
      if (text[end] === '}') depth -= 1
      end += 1
    }
    const body = text.slice(open + 1, end - 1)
    if (prelude.startsWith('@media')) result.push(...parseRules(body, prelude.slice(6).trim()))
    else if (!prelude.startsWith('@')) {
      const declarations: Record<string, string> = {}
      for (const declaration of body.split(';')) {
        const colon = declaration.indexOf(':')
        if (colon > 0) declarations[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim()
      }
      result.push({ selectors: prelude.split(',').map((selector) => selector.trim()), declarations, media })
    }
    cursor = end
  }
  return result
}

const rules = parseRules(readFileSync(new URL('../src/client/WebdavSyncCard.module.css', import.meta.url), 'utf8'))
function style(selector: string, media = ''): Record<string, string> {
  return Object.assign({}, ...rules.filter((rule) => rule.media === media && rule.selectors.includes(selector)).map((rule) => rule.declarations))
}
function chapterHeadings(html: string): string[] {
  return [...html.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/g)].map((match) => {
    expect(match[0]).toMatch(/^<section class="section">/)
    const heading = match[1].match(/<h4\b[^>]*>([\s\S]*?)<\/h4>/)
    expect(heading, 'each chapter has one h4').not.toBeNull()
    return heading![1].replace(/<button\b[\s\S]*?<\/button>/g, '').replace(/<span\b[\s\S]*?<\/span>/g, '').trim()
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('settings page visual structure', () => {
  it('has five distinct chapters in reading order, with no extra preview chapter', async () => {
    const expected = [zh.addressLegend, zh.autoLegend, zh.partsLegend, zh.backupLegend, zh.relayLegend]
    expect(chapterHeadings(await render())).toEqual(expected)
    const html = await render({ error: 'status warning', preview: { changes: [] }, message: 'sync result', reloadNeeded: true })
    expect(chapterHeadings(html)).toEqual(expected)
    const parts = [...html.matchAll(/<section\b[^>]*>([\s\S]*?)<\/section>/g)][2][1]
    expect(parts).toMatch(/<h5 class="previewTitle">/)
    expect(parts).toContain('sync result')
    expect(parts).toContain(zh.previewEmpty)
  })

  it('retains field label associations and named SVG actions', async () => {
    const html = await render()
    for (const id of ['url', 'user', 'password', 'passphrase', 'headers']) {
      expect(html).toContain(`for="webdav-sync-${id}"`)
      expect(html).toContain(`id="webdav-sync-${id}"`)
    }
    expect(html).toMatch(/class="legendIcon"[^>]*aria-label=/)
    expect(html.match(/class="relayCopy"[^>]*aria-label=/g)).toHaveLength(3)
    // Both backup rows are named buttons; only refresh and copy use SVGs.
    expect(html.match(/class="backupRow"[^>]*aria-label=/g)).toHaveLength(2)
    expect(html.match(/<svg\b/g)).toHaveLength(4)
  })

  it('says off for a host turned off, whose passphrase is kept on purpose', async () => {
    // Turning sync off clears the address but keeps the passphrase, so reading
    // Off out of "no passphrase" drew every turned-off host as "on, no address
    // yet" — a card claiming sync runs when it does not.
    const off = await render({ view: { ...status, configured: false, config: { ...config, url: '', passphraseSet: true } } }, 'summary')
    expect(off).toContain(zh.cardSummaryOff)
    expect(off).not.toContain(zh.cardSummaryIncomplete)

    const halfSet = await render({ view: { ...status, config: { ...config, passphraseSet: false } } }, 'summary')
    expect(halfSet).toContain(zh.cardSummaryIncomplete)
    expect(halfSet).not.toContain(zh.cardSummaryOff)

    const on = await render({}, 'summary')
    expect(on).toContain('https://dav.test/dav')
  })

  it('tells the page about a sync that failed on its own', async () => {
    // A failure from the timer is recorded by the host, not by this card: with
    // no line for it the times would simply stop moving and nothing would say
    // why.
    const html = await render({ view: { ...status, error: '这台电脑连不上服务器' } })
    expect(html).toContain(zh.lastSyncFailed.replace('{message}', '这台电脑连不上服务器'))
    const quiet = await render()
    expect(quiet).not.toContain('上次同步没成功')
  })
})

describe('settings page CSS contracts', () => {
  it('separates chapters, not each ordinary content row', () => {
    expect(style('.section')['border-top']).toMatch(/^1px solid/)
    expect(style('.section')['padding-top']).toBe('16px')
    expect(style('.page > .section:first-of-type')['border-top']).toBe('none')
    for (const selector of ['.partRow', '.dirList', '.backupRow']) {
      expect([undefined, 'none']).toContain(style(selector)['border-bottom'])
      expect([undefined, 'none']).toContain(style(selector)['border-top'])
    }
  })

  it('keeps scoped chapter typography above body text and helpers', () => {
    const heading = style('.page .legend')
    expect(heading).toMatchObject({ 'font-size': '15px', 'font-weight': '600', color: 'var(--dsw-alias-label-primary)' })
    expect(style('.page')['font-size']).toBe('13px')
    for (const selector of ['.fieldLabel', '.labelRow label', '.partRow label', '.relaySwitch label', '.backupTitle']) {
      expect(style(selector)['font-size']).toBe('13px')
    }
    for (const selector of ['.page .hint', '.page .fieldHint', '.page .note', '.partHint', '.backupHint']) {
      expect(style(selector)).toMatchObject({ 'font-size': '12px', 'line-height': '18px' })
    }
    expect(style('.page .legendAction')['align-items']).toBe('center')
    expect(style(".field input:not([type='checkbox'])")['font-size']).toBe('13px')
    expect(style('.headersArea')['font-size']).toBe('13px')
    for (const selector of ['.page', '.page .legend', '.field', '.backupRow']) {
      expect(rules.filter((rule) => !rule.media && rule.selectors.includes(selector)), `${selector} has one canonical base definition`).toHaveLength(1)
    }
  })

  it('sizes SVGs explicitly while preserving 24/28px hit targets', () => {
    for (const selector of ['.legend button.legendIcon svg', 'button.relayCopy svg']) {
      expect(style(selector)).toMatchObject({ width: '14px', height: '14px' })
    }
    for (const selector of ['.legend button.legendIcon', 'button.relayCopy']) {
      expect(style(selector)).toMatchObject({ width: '24px', height: '24px', padding: '0' })
    }
    expect(style('.titleRow button')['min-height']).toBe('24px')
  })

  it('makes the entire backup row clickable with hover and disabled feedback', () => {
    expect(style('.backupRow')).toMatchObject({
      display: 'block', width: '100%', padding: '8px 0', border: '0',
      background: 'transparent', 'text-align': 'left', cursor: 'pointer',
    })
    expect(style('.backupRow:hover:not(:disabled)').background).toBe('var(--dsw-alias-interactive-bg-hover)')
    expect(style('.backupRow:disabled')).toMatchObject({ cursor: 'not-allowed', opacity: '0.5' })
  })

  it('provides narrow layout, keyboard focus, and reduced motion rules', () => {
    const narrow = '(max-width: 520px)'
    expect(style('.grid', narrow)['grid-template-columns']).toBe('minmax(0, 1fr)')
    expect(style('.relayAccountRow', narrow)['flex-direction']).toBe('column')
    expect(style('.times', narrow)['flex-direction']).toBe('column')
    for (const selector of ['.page button:focus-visible', '.page input:focus-visible', '.page textarea:focus-visible']) {
      expect(style(selector).outline).toContain('var(--dsw-focus-ring-width)')
      expect(style(selector)['outline-offset']).toBe('2px')
    }
    expect(style('.spin', '(prefers-reduced-motion: reduce)').animation).toBe('none')
  })
})
