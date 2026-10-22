/**
 * The part rows: the box, and the word at its right.
 *
 * The box used to be drawn from the status the host had already reported
 * (`part.synced`) while the click wrote the draft. A controlled `<Checkbox>`
 * drawn from the stored value is put straight back to it, so checking a part
 * showed nothing until a save reloaded the status — the bug this file pins. The
 * box now reads the draft, and the state word is asked with the same draft: while
 * the two disagree, none of the four standing words is true, so the row says the
 * change is waiting for the save.
 */

import React, { type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebdavSyncCard } from '../src/client/card-store.ts'
import type { CardActions, CardState } from '../src/client/card-store.ts'
import { en } from '../src/client/locales.ts'
import { WebdavSyncSection, type WebdavSyncSectionProps } from '../src/client/WebdavSyncCard.tsx'
import { PARTS, RELAY_DEFAULT_PORT, type ConfigView, type InstallResult, type Part, type PartView, type StatusResult } from '../src/wire.ts'

vi.mock('../src/client/WebdavSyncCard.module.css', () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}))

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { createElement, Fragment } = await import('react')
  const Button = ({ children, icon, ...props }: { children?: ReactNode; icon?: ReactNode; [key: string]: unknown }) =>
    createElement('button', props, icon != null && createElement('span', { className: 'icon' }, icon), children)
  // The real box is controlled; this one keeps that property, so a row bound to
  // the wrong value renders exactly as it behaves.
  const Checkbox = ({ checked, label, onChange, ...props }: { checked: boolean; label: ReactNode; onChange?: (next: boolean) => void; [key: string]: unknown }) =>
    createElement('label', props, createElement('input', { type: 'checkbox', checked, readOnly: true, onChange: () => onChange?.(!checked) }), label)
  const Input = (props: Record<string, unknown>) => createElement('input', props)
  const SegmentedControl = ({ label }: { label?: ReactNode }) => createElement('span', null, label)
  const Tag = ({ children }: { children?: ReactNode }) => createElement('span', null, children)
  const Tooltip = ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children)
  const IconCopyOutlineRegular = () => createElement('span', { className: 'copy-icon' })
  const IconCheckOutlineRegular = () => createElement('span', { className: 'check-icon' })
  const IconRefreshOutlineRegular = () => createElement('span', { className: 'refresh-icon' })
  const IconCloseOutlineRegular = () => createElement('span', { className: 'close-icon' })
  const writeClipboard = vi.fn(async () => true)
  return { Button, Checkbox, IconCopyOutlineRegular, IconCheckOutlineRegular, IconRefreshOutlineRegular, IconCloseOutlineRegular, Input, SegmentedControl, Tag, Tooltip, writeClipboard }
})

/** The configuration the host reports: `models` is the one profile part it is not carrying. */
const CONFIG: ConfigView = {
  url: 'https://dav.test/dav',
  user: 'me',
  passwordSet: true,
  passphraseSet: true,
  autoEvery: -1,
  models: false,
  plugins: true,
  patch: true,
  keys: true,
  dirs: [],
  dirsEnabled: true,
  rememberPassword: true,
  headers: '',
  relayEnabled: false,
  relayPort: RELAY_DEFAULT_PORT,
}

/** One `PartView` per part, in the host's order, with nothing changed anywhere. */
function parts(synced: Partial<Record<Part, boolean>> = {}): PartView[] {
  return PARTS.map((part) => ({
    part,
    local: `hash-${part}`,
    remote: `hash-${part}`,
    localChanged: false,
    remoteChanged: false,
    synced: synced[part] ?? true,
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
    parts: parts({ models: false }),
    pendingInstall: false,
    undoable: false,
  }
}

/**
 * A card that has read one status, so the rows have something to draw.
 *
 * `after` answers the calls that follow, in order: an action's own answer first,
 * then the status read it is always followed by. The first read is always the
 * status, since that is what makes the rows drawable.
 */
async function ready(...after: unknown[]): Promise<{ card: WebdavSyncCard; actions: CardActions }> {
  let index = -1
  vi.stubGlobal('fetch', async () => {
    index += 1
    const payload = index === 0 || after.length === 0 ? { ...status(), ok: true } : after[Math.min(index - 1, after.length - 1)]
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  const card = new WebdavSyncCard()
  await card.load()
  return { card, actions: card.actions() }
}

/** The settings seat over the card's own snapshot, worded by the real dictionary. */
function render(card: WebdavSyncCard): string {
  const props = {
    ...card.actions(),
    t: (key: keyof typeof en) => en[key],
    useWebdavSync: (select: (state: CardState) => CardState) => select(card.getSnapshot()),
  } as unknown as WebdavSyncSectionProps
  return renderToStaticMarkup(<WebdavSyncSection {...props} />)
}

/**
 * One part row: from its own box to the state word that closes the row.
 *
 * Every row is a `div` holding spans only, so the first `</div>` after the name
 * is the row's own end — no counter needed to know how far the row runs.
 */
function row(html: string, name: string): string {
  const named = html.indexOf(`>${name}</label>`)
  expect(named, `no row named ${name}`).toBeGreaterThan(-1)
  const at = html.lastIndexOf('<label', named)
  const end = html.indexOf('</div>', named)
  return html.slice(at, end === -1 ? undefined : end)
}

// React orders the attributes it writes itself, so the box is matched by shape
// rather than by the order the stub hands them over in.
const CHECKED = /<input type="checkbox"[^>]* checked=""/

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('status refresh controls', () => {
  /** The 「同步内容」 heading block, from its `h4` to that `h4`'s end. */
  function heading(html: string): string {
    const named = html.indexOf(`>${en.partsLegend}<`)
    expect(named, 'no parts heading').toBeGreaterThan(-1)
    const at = html.lastIndexOf('<h4', named)
    const end = html.indexOf('</h4>', named)
    return html.slice(at, end === -1 ? undefined : end)
  }

  it('puts the status refresh right after the section title, as an icon', async () => {
    const { card } = await ready()
    const html = render(card)
    const title = heading(html)

    // On the title line, and only a glyph there: the words live in the accessible
    // name and the tooltip, not as a second 12px label beside the heading.
    expect(title).toContain(`aria-label="${en.refreshStatus}"`)
    expect(title).toContain('refresh-icon')
    expect(title).not.toContain(`>${en.refreshStatus}<`)
    // Off the timestamps row, where it used to sit.
    const times = html.slice(html.indexOf('<div class="times">'), html.indexOf('</div>', html.indexOf('<div class="times">')))
    expect(times).not.toContain('<button')
  })

  it('warns about stale times after a polling failure without hiding the form', async () => {
    const { card, actions } = await ready()
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'offline' }), { status: 503 }))
    actions.poll()
    await vi.waitFor(() => expect(card.getSnapshot().error).toBe('offline'))
    const html = render(card)
    expect(html).toContain(en.statusStale)
    expect(html).toContain('offline')
    expect(heading(html)).toContain(`aria-label="${en.refreshStatus}"`)
    expect(html).toContain('webdav-sync-url')
  })
})

describe('the part rows', () => {
  it('draws the switches in the order the parts travel, keys second', async () => {
    const { card } = await ready()
    const html = render(card)
    // The names the card puts on the rows, read from the dictionary it words them with.
    const named: Record<Part, string> = {
      models: en.partModels,
      keys: en.partKeys,
      plugins: en.partPlugins,
      patch: en.partPatch,
      dirs: en.partDirs,
    }
    // Every boxed row of this section, in the order the card drew it. The card's
    // other boxes (「记住密码」, the forwarder's switch) are not part rows, so they
    // are left out by name rather than by position.
    const drawn = [...html.matchAll(/<label[^>]*><input type="checkbox"[^>]*>([^<]+)<\/label>/g)]
      .map((match) => match[1])
      .filter((name) => Object.values(named).includes(name))
    // `keys` sits right under `models` because the keys belong to the providers in
    // the row below them — an owner reading the card looks for the two together —
    // and 附加目录 keeps its switch as the last of them.
    expect(drawn).toEqual(PARTS.map((part) => named[part]))
  })

  it('checks at once when the draft takes a part on, before any save', async () => {
    const { card, actions } = await ready()
    actions.toggle('models', true)

    const models = row(render(card), en.partModels)

    expect(models).toMatch(CHECKED)
    // Not "Not synced" (the status still says it is) and not "In step" (nothing
    // has been saved): the change is waiting.
    expect(models).toContain(en.partUnsaved)
    expect(models).not.toContain(en.partOff)
    expect(models).not.toContain(en.partSynced)
  })

  it('empties at once when the draft leaves a part out, before any save', async () => {
    const { card, actions } = await ready()
    actions.toggle('patch', false)

    const patch = row(render(card), en.partPatch)

    expect(patch).not.toMatch(CHECKED)
    expect(patch).toContain(en.partUnsaved)
  })

  it('keeps the ordinary words while the draft and the status agree', async () => {
    const { card } = await ready()
    const html = render(card)

    expect(row(html, en.partModels)).not.toMatch(CHECKED)
    expect(row(html, en.partModels)).toContain(en.partOff)
    expect(row(html, en.partPatch)).toMatch(CHECKED)
    expect(row(html, en.partPatch)).toContain(en.partSynced)
    expect(row(html, en.partDirs)).toContain(en.partSynced)
  })

  it('says the same for the extra directories as for the parts above', async () => {
    const { card, actions } = await ready()
    actions.toggle('dirsEnabled', false)

    const dirs = row(render(card), en.partDirs)

    expect(dirs).not.toMatch(CHECKED)
    expect(dirs).toContain(en.partUnsaved)
  })
})

describe('the install report', () => {
  /** The report's own block: from its sentence to the log's end. */
  function report(html: string): string {
    const at = html.indexOf(en.installOk)
    const failed = html.indexOf(en.installFailed)
    const start = at === -1 ? failed : at
    expect(start, 'no install report').toBeGreaterThan(-1)
    const end = html.indexOf('</pre>', start)
    return html.slice(start, end === -1 ? undefined : end)
  }

  it('carries a way to close itself, next to the sentence and not only in the log', async () => {
    // The bug: the report stayed on the page for good. Nothing on the card took
    // it away except 放弃改动, which is about unsaved settings, not about a log.
    const { card, actions } = await ready(
      { ok: true, output: 'pnpm finished' } satisfies InstallResult,
      { ...status(), ok: true },
    )
    expect(render(card)).not.toContain(en.installOk)

    actions.install()
    await vi.waitFor(() => {
      expect(card.getSnapshot().installOutput).toBe('pnpm finished')
    })

    const after = render(card)
    expect(report(after)).toContain(en.outputClose)
    expect(after).toContain('pnpm finished')
  })

  it('is gone once it is closed, and takes nothing else with it', async () => {
    const { card, actions } = await ready(
      { ok: true, output: 'pnpm finished' } satisfies InstallResult,
      { ...status(), ok: true },
    )
    actions.install()
    await vi.waitFor(() => {
      expect(render(card)).toContain('pnpm finished')
    })

    actions.closeOutput()

    const html = render(card)
    expect(html).not.toContain('pnpm finished')
    expect(html).not.toContain(en.outputClose)
    // The rest of the card is still there: closing a log is not a reset.
    expect(html).toContain(en.partModels)
    expect(html).toContain(en.save)
  })
})
