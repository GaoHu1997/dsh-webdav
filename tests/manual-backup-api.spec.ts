import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestExport, requestImport } from '../src/client/api.ts'
import { WebdavSyncCard } from '../src/client/card-store.ts'
import { ROUTE_EXPORT } from '../src/wire.ts'

const exported = { file: '/tmp/backup.prop', size: 2048, parts: ['patch'] }
const imported = { here: ['patch'], same: [], reloadNeeded: true, pendingInstall: false, created: '2026-10-21T12:00:00Z' }
const body = { passphrase: 'own-file-secret', dir: '/tmp' }

function answer(value: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetcher = vi.fn(async () => Response.json(value, { status }))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

async function idle(card: WebdavSyncCard): Promise<void> {
  await vi.waitFor(() => expect(card.getSnapshot().busy).toBe(''))
}

afterEach(() => vi.unstubAllGlobals())

describe('manual backup request protocol', () => {
  it('uses the host POST routes and requires a confirmed file result', async () => {
    const fetcher = answer(exported)
    expect(await requestExport(body)).toEqual({ ok: true, data: exported })
    expect(fetcher).toHaveBeenCalledWith(ROUTE_EXPORT, expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }))
    answer(imported)
    expect(await requestImport({ passphrase: body.passphrase, text: 'sealed' })).toEqual({ ok: true, data: imported })
  })

  it.each([401, 403, 404, 405, 502])('explains non-JSON HTTP %s without retrying a write', async (status) => {
    const fetcher = vi.fn(async () => new Response('<html>host error</html>', { status }))
    vi.stubGlobal('fetch', fetcher)
    const result = await requestExport(body)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain(`POST ${ROUTE_EXPORT}`)
    expect(result.error).toContain(`HTTP ${status}`)
    expect(result.error).toContain('不是 JSON')
    if (status === 404 || status === 405) expect(result.error).toContain('前端与宿主插件为同一版本')
    if (status === 401 || status === 403) expect(result.error).toContain('重新打开')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('preserves the host error instead of hiding it behind an HTTP fallback', async () => {
    answer({ error: '导出文件已存在，不会覆盖' }, 400)
    expect(await requestExport(body)).toEqual({ ok: false, error: '导出文件已存在，不会覆盖' })
  })

  it.each([null, [], {}, { file: '/tmp/file.prop' }, { ...exported, size: 0 }, { ...exported, parts: ['unknown'] }])('refuses an incomplete successful export response %#', async (value) => {
    answer(value)
    expect((await requestExport(body)).ok).toBe(false)
  })

  it.each([{}, { ...imported, here: null }, { ...imported, same: ['unknown'] }, { ...imported, pendingInstall: undefined }])('refuses an incomplete successful import response %#', async (value) => {
    answer(value)
    expect((await requestImport({ passphrase: 'secret', text: 'sealed' })).ok).toBe(false)
  })

  it('reports a network exception as a failed call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network offline') }))
    expect(await requestExport(body)).toEqual({ ok: false, error: 'network offline' })
  })
})

describe('manual backup retry state', () => {
  it('keeps the export form and inputs after a 405 and succeeds on an explicit retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 405 })))
    const card = new WebdavSyncCard()
    card.openExport()
    card.editExport('passphrase', body.passphrase)
    card.editExport('dir', body.dir)
    card.runExport()
    await idle(card)
    expect(card.getSnapshot()).toMatchObject({ exportOpen: true, exportPassphrase: body.passphrase, exportDir: body.dir, messageFailed: true })
    expect(card.getSnapshot().exported).toBeUndefined()
    answer(exported)
    card.runExport()
    await idle(card)
    expect(card.getSnapshot()).toMatchObject({ exportOpen: false, exportPassphrase: '', exported, messageFailed: false })
  })

  it('does not submit twice while an export is already running', async () => {
    let complete!: (value: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { complete = resolve }))
    vi.stubGlobal('fetch', fetcher)
    const card = new WebdavSyncCard()
    card.editExport('passphrase', body.passphrase)
    card.runExport()
    card.runExport()
    expect(fetcher).toHaveBeenCalledTimes(1)
    complete(Response.json(exported))
    await idle(card)
  })

  it('reports an unavailable directory picker instead of silently doing nothing', () => {
    const card = new WebdavSyncCard()
    card.pickExportDir()
    expect(card.getSnapshot()).toMatchObject({ messageFailed: true, exportDir: '' })
    expect(card.getSnapshot().message).toContain('手动填写绝对路径')
  })

  it('reports a failed directory picker and keeps a previously entered path', async () => {
    const card = new WebdavSyncCard(async () => { throw new Error('unavailable') })
    card.editExport('dir', '/previous')
    card.pickExportDir()
    await vi.waitFor(() => expect(card.getSnapshot().messageFailed).toBe(true))
    expect(card.getSnapshot().exportDir).toBe('/previous')
    expect(card.getSnapshot().message).toContain('目录选择未成功')
  })
})
