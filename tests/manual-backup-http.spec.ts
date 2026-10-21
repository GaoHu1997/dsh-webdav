/**
 * Manual backup through the same real HTTP boundary the browser card uses.
 * No WebDAV is involved: the socket only fronts the registered Host routes.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { requestExport, requestImport } from '../src/client/api.ts'
import { ROUTE_EXPORT, ROUTE_IMPORT } from '../src/wire.ts'
import { open } from '../src/crypto.ts'
import { cleanUp, tempDir, writeProfile } from './harness.ts'

const servers: Server[] = []
const disposals: Array<() => void> = []
const networkFetch = globalThis.fetch

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected an ephemeral TCP address')
  return `http://127.0.0.1:${address.port}`
}

function host(profileDir: string): Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  const ctx = {
    get: () => undefined,
    webServer: {
      register(route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    },
    inject(names: string[], callback: (context: unknown) => void) {
      if (names.includes('webServer')) callback(ctx)
    },
    effect(factory: () => unknown) {
      const dispose = factory()
      if (typeof dispose === 'function') disposals.push(dispose as () => void)
    },
  }
  apply(ctx as unknown as Context, { profileDir })
  return routes
}

function socketFor(routes: Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>): Server {
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url ?? '/', 'http://localhost').pathname)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'route not found' }))
      return
    }
    void handler(req, res)
  })
  servers.push(server)
  return server
}

async function profileSnapshot(profile: Awaited<ReturnType<typeof writeProfile>>): Promise<Record<string, string>> {
  const files = [profile.patchFile, profile.packageFile, join(profile.stateDir, 'sync.json')]
  return Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(file, 'utf8').catch(() => '')] as const)))
}

function clientFetchAt(origin: string): void {
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    return networkFetch(new URL(url, origin), init)
  })
}

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const dispose of disposals.splice(0).reverse()) dispose()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  vi.restoreAllMocks()
  await cleanUp()
})

describe('manual backup HTTP routes', () => {
  it('writes through the client API, refuses a wrong passphrase without writes, then imports on another profile', async () => {
    const source = await writeProfile()
    const sourceRoutes = host(source.profileDir)
    const sourceOrigin = await listen(socketFor(sourceRoutes))
    clientFetchAt(sourceOrigin)
    const folder = await tempDir('dsh-webdav-http-out-')

    const exported = await requestExport({ passphrase: 'file secret', dir: folder })
    expect(exported.ok).toBe(true)
    if (!exported.ok) throw new Error(exported.error)
    expect(await readdir(folder)).toEqual([exported.data.file.split(/[\\/]/).pop()])
    expect(await open(await readFile(exported.data.file), 'file secret')).toBeDefined()

    const target = await writeProfile('')
    const targetRoutes = host(target.profileDir)
    const targetOrigin = await listen(socketFor(targetRoutes))
    clientFetchAt(targetOrigin)
    const text = await readFile(exported.data.file, 'utf8')
    const before = await readFile(target.patchFile, 'utf8').catch(() => '')

    const refused = await requestImport({ passphrase: 'wrong secret', text })
    expect(refused).toMatchObject({ ok: false })
    expect(await readFile(target.patchFile, 'utf8').catch(() => '')).toBe(before)

    const imported = await requestImport({ passphrase: 'file secret', text })
    expect(imported.ok).toBe(true)
    if (!imported.ok) throw new Error(imported.error)
    expect(imported.data.here).toEqual(expect.arrayContaining(['models', 'patch']))
    expect(await readFile(target.patchFile, 'utf8')).toContain('FREE_API_KEY')
  })

  it('allows only GET for status and POST for actions, with JSON errors and no side effects', async () => {
    const profile = await writeProfile()
    const routes = host(profile.profileDir)
    const origin = await listen(socketFor(routes))
    const before = await profileSnapshot(profile)

    const wrongMethod = await fetch(`${origin}${ROUTE_EXPORT}`, { method: 'GET' })
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('POST')
    expect(await wrongMethod.json()).toMatchObject({ error: expect.any(String) })

    const wrongStatusMethod = await fetch(`${origin}/plugin/webdav-sync/status`, { method: 'POST', body: '{}' })
    expect(wrongStatusMethod.status).toBe(405)
    expect(wrongStatusMethod.headers.get('allow')).toBe('GET')
    expect(await wrongStatusMethod.json()).toMatchObject({ error: expect.any(String) })

    const badShape = await fetch(`${origin}${ROUTE_EXPORT}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: 42 }),
    })
    expect(badShape.status).toBe(400)
    expect(await badShape.json()).toMatchObject({ error: '「passphrase」必须是字符串' })
    expect(await profileSnapshot(profile)).toEqual(before)

    for (const value of ['null', '[]', '42']) {
      const invalidJsonShape = await fetch(`${origin}${ROUTE_IMPORT}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: value,
      })
      expect(invalidJsonShape.status).toBe(400)
      expect(await invalidJsonShape.json()).toMatchObject({ error: '请求内容必须是 JSON 对象' })
    }

    const badText = await fetch(`${origin}${ROUTE_IMPORT}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: { file: 'backup' } }),
    })
    expect(badText.status).toBe(400)
    expect(await badText.json()).toMatchObject({ error: '「text」必须是字符串' })

    const badDir = await fetch(`${origin}${ROUTE_EXPORT}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: 42 }),
    })
    expect(badDir.status).toBe(400)
    expect(await badDir.json()).toMatchObject({ error: '「dir」必须是字符串' })

    const oversized = await fetch(`${origin}${ROUTE_EXPORT}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: 'x'.repeat(64 * 1024) }),
    })
    expect(oversized.status).toBe(400)
    expect(await oversized.json()).toMatchObject({ error: '请求内容过大' })

    const statusAfterOversized = await fetch(`${origin}/plugin/webdav-sync/status`)
    expect(statusAfterOversized.status).toBe(200)
    expect(await statusAfterOversized.json()).toMatchObject({ configured: false })
    expect(await profileSnapshot(profile)).toEqual(before)
  })
})
