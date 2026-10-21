/**
 * The manual backup section: two rows, one file each way.
 *
 * The section exists because a setup has to be able to reach a computer that has
 * no address, no account and no network yet. What this file pins is the shape the
 * rows were asked for — a name and a sentence on the left, one text action at the
 * right end — and that each row's form stays shut until that row is asked for: a
 * passphrase box sitting on the card for good would read as a setting to keep,
 * when it is one file's one question.
 *
 * The behaviour behind the rows (sealing, writing, keeping the replaced copy) is
 * the host half's, and is pinned in `tests/manual-backup.spec.ts`.
 */

import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebdavSyncCard } from '../src/client/card-store.ts'
import type { CardState } from '../src/client/card-store.ts'
import { en } from '../src/client/locales.ts'
import { WebdavSyncSection, type WebdavSyncSectionProps } from '../src/client/WebdavSyncCard.tsx'
import { PARTS, RELAY_DEFAULT_PORT, type ConfigView, type ExportResult, type PartView, type StatusResult } from '../src/wire.ts'

vi.mock('../src/client/WebdavSyncCard.module.css', () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement, Fragment } = await import('react')
  const Button = ({ children, icon, ...props }: { children?: ReactNode; icon?: ReactNode; [key: string]: unknown }) =>
    createElement('button', props, icon != null && createElement('span', { className: 'icon' }, icon), children)
  const Checkbox = ({ checked, label, onChange, ...props }: { checked: boolean; label: ReactNode; onChange?: (next: boolean) => void; [key: string]: unknown }) =>
    createElement('label', props, createElement('input', { type: 'checkbox', checked, readOnly: true, onChange: () => onChange?.(!checked) }), label)
  const Input = (props: Record<string, unknown>) => createElement('input', props)
  const SegmentedControl = ({ label }: { label?: ReactNode }) => createElement('span', null, label)
  const Tag = ({ children }: { children?: ReactNode }) => createElement('span', null, children)
  const Tooltip = ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children)
  const IconCopyOutlineRegular = () => createElement('span', { className: 'copy-icon' })
  const IconCheckOutlineRegular = () => createElement('span', { className: 'check-icon' })
  const IconRefreshOutlineRegular = () => createElement('span', { className: 'refresh-icon' })
  const writeClipboard = vi.fn(async () => true)
  return { Button, Checkbox, IconCopyOutlineRegular, IconCheckOutlineRegular, IconRefreshOutlineRegular, Input, SegmentedControl, Tag, Tooltip, writeClipboard }
})

const CONFIG: ConfigView = {
  url: 'https://dav.test/dav',
  user: 'me',
  passwordSet: true,
  passphraseSet: true,
  autoEvery: -1,
  models: true,
  plugins: true,
  patch: true,
  keys: true,
  dirs: [],
  dirsEnabled: false,
  rememberPassword: true,
  headers: '',
  relayEnabled: false,
  relayPort: RELAY_DEFAULT_PORT,
}

function parts(): PartView[] {
  return PARTS.map((part) => ({
    part,
    local: `hash-${part}`,
    remote: `hash-${part}`,
    localChanged: false,
    remoteChanged: false,
    synced: true,
  }))
}

function status(): StatusResult {
  return {
    configured: true,
    config: CONFIG,
    paths: {
      profileDir: '/p',
      stateDir: '/p/.dsh-webdav-sync',
      patchFile: '/p/cordis.patch.yml',
      packageFile: '/p/package.json',
    },
    error: '',
    parts: parts(),
    pendingInstall: false,
    undoable: false,
  }
}

/** A card that has read one status, plus the answers the next calls get. */
async function ready(...after: unknown[]): Promise<WebdavSyncCard> {
  let index = -1
  vi.stubGlobal('fetch', async () => {
    index += 1
    const payload = index === 0 || after.length === 0 ? { ...status(), ok: true } : after[Math.min(index - 1, after.length - 1)]
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const card = new WebdavSyncCard()
  await card.load()
  return card
}

function render(card: WebdavSyncCard): string {
  const props = {
    ...card.actions(),
    // Interpolating, the way the real dictionary lookup does, so a report that
    // forgets to pass its values shows up here as `{file}`.
    t: (key: keyof typeof en, params?: Record<string, unknown>) =>
      (en[key] as string).replace(/\{(\w+)\}/g, (whole, name: string) =>
        params?.[name] === undefined ? whole : String(params[name])),
    useWebdavSync: (select: (state: CardState) => CardState) => select(card.getSnapshot()),
  } as unknown as WebdavSyncSectionProps
  return renderToStaticMarkup(<WebdavSyncSection {...props} />)
}

/** The section, from its heading to the end of the element that closes it. */
function section(html: string): string {
  const named = html.indexOf(`>${en.backupLegend}<`)
  expect(named, 'no manual backup heading').toBeGreaterThan(-1)
  const at = html.lastIndexOf('<section', named)
  return html.slice(at)
}

/** One row of the section: its title through the action that closes it. */
function row(html: string, title: string): string {
  const named = html.indexOf(`>${title}<`)
  expect(named, `no row titled ${title}`).toBeGreaterThan(-1)
  const at = html.lastIndexOf('<div', named)
  const end = html.indexOf('</div>', named)
  return html.slice(at, end === -1 ? undefined : end)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the manual backup rows', () => {
  it('sits under the parts section as one heading with two rows', async () => {
    const html = render(await ready())
    const block = section(html)

    expect(block).toContain(en.backupLegend)
    expect(block.indexOf(en.exportTitle)).toBeLessThan(block.indexOf(en.importTitle))
  })

  it('gives each row a name, a sentence and one action at the right end', async () => {
    const html = render(await ready())
    const exported = row(html, en.exportTitle)
    const imported = row(html, en.importTitle)

    // The shape asked for: the words on the left, the action on the right.
    expect(exported).toContain(en.exportHint)
    expect(exported).toContain(`>${en.exportAction}<`)
    expect(imported).toContain(en.importHint)
    expect(imported).toContain(`>${en.importAction}<`)
    // One action per row, not a pair of buttons.
    expect(exported.match(/<button/g) ?? []).toHaveLength(1)
    expect(imported.match(/<button/g) ?? []).toHaveLength(1)
  })

  it('keeps both forms shut until their row is asked for', async () => {
    const card = await ready()
    const before = section(render(card))

    expect(before).not.toContain('webdav-sync-export-passphrase')
    expect(before).not.toContain('webdav-sync-import-passphrase')
    expect(before).toContain(`aria-expanded="false"`)
  })

  it('opens the export form with its own passphrase and a place to save', async () => {
    const card = await ready()
    card.actions().openExport()
    const block = section(render(card))

    expect(block).toContain('webdav-sync-export-passphrase')
    expect(block).toContain(en.exportPassphraseHint)
    expect(block).toContain('webdav-sync-export-dir')
    expect(block).toContain(en.exportDirChoose)
    // The sync passphrase is not offered here: one leaked file must not open the
    // server's copy, so the field starts empty.
    expect((card.getSnapshot().exportPassphrase as string)).toBe('')
    // And the import row is still just a row.
    expect(block).not.toContain('webdav-sync-import-passphrase')
  })

  it('opens the import form with a passphrase and the file it read', async () => {
    const card = await ready()
    card.actions().openImport()
    const block = section(render(card))

    expect(block).toContain('webdav-sync-import-passphrase')
    expect(block).toContain(en.importFileChoose)
    // Nothing picked yet, and the row says so rather than showing an empty gap.
    expect(block).toContain(en.importNoFile)
    expect(block).toContain('type="file"')
  })

  it('reports where the file went, once it went there', async () => {
    const exported: ExportResult = { file: '/home/me/dsh-webdav-20261021-181500.prop', size: 2048, parts: ['patch'] }
    const card = await ready({ ok: true, ...exported }, { ...status(), ok: true })
    card.actions().openExport()
    card.actions().editExport('passphrase', 'a file passphrase')
    card.actions().runExport()
    await vi.waitFor(() => expect(card.getSnapshot().exported?.file).toBe(exported.file))

    const block = section(render(card))
    expect(block).toContain(exported.file)
    expect(block).toContain('2.0 KiB')
    // The form closed itself: the report replaces the question.
    expect(block).not.toContain('webdav-sync-export-passphrase')
  })

  it('refuses to start an export with no passphrase, before asking the host', async () => {
    const card = await ready()
    card.actions().openExport()
    card.actions().runExport()

    expect(card.getSnapshot().exportOpen).toBe(true)
    expect(card.getSnapshot().messageFailed).toBe(true)
    expect(card.getSnapshot().message).toContain('口令')
  })
})
