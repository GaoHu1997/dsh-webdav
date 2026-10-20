/**
 * Host wiring, rather than RelayServer in isolation: a minimal Cordis Context
 * mounts the real apply() handlers on a loopback HTTP server. The other end is
 * a recording WebDAV server, so the credentials sent there are observable.
 */

import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import * as engines from '../src/engine.ts'
import { RelayServer } from '../src/relay.ts'
import { heldPassword, loadConfig, saveConfig } from '../src/state.ts'
import {
  ROUTE_CHECK, ROUTE_CONFIG, ROUTE_DISMISS, ROUTE_INSTALL, ROUTE_OFF,
  ROUTE_PREVIEW, ROUTE_RESTORE, ROUTE_STATUS, ROUTE_SYNC, ROUTE_UNDO, ROUTE_UPLOAD,
  type ConfigureBody, type StatusResult, type SyncConfig,
} from '../src/wire.ts'
import { cleanUp, configFor, settle, writeProfile } from './harness.ts'
import type { ResolvedPaths } from '../src/paths.ts'

interface Answer {
  status: number
  body: string
}

interface Seen {
  method: string
  url: string
  headers: IncomingHttpHeaders
}

const sockets: Server[] = []
const disposals: Array<() => Promise<void>> = []

async function listen(server: Server): Promise<number> {
  sockets.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return (server.address() as AddressInfo).port
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

async function freePort(): Promise<number> {
  const probe = createServer()
  const port = await listen(probe)
  await close(probe)
  return port
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`
}

function ask(
  port: number,
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1', port, path, method: options.method ?? 'GET',
      headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
      // No pooled connection can conceal that /off or disposal closed the port.
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      response.on('error', reject)
    })
    request.on('error', reject)
    request.setTimeout(10_000, () => request.destroy(new Error('test HTTP request timed out')))
    request.end(options.body === undefined ? undefined : JSON.stringify(options.body))
  })
}

async function upstream(): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = []
  const port = await listen(createServer((request, response) => {
    seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers })
    request.resume()
    request.on('end', () => response.end('upstream-response'))
  }))
  return { port, seen }
}

interface Registration {
  kind: string
  path: string
  handler(request: IncomingMessage, response: ServerResponse): void | Promise<void>
}

/** Only the Context services apply() actually consumes, each with disposal. */
async function host(paths: ResolvedPaths) {
  const registered = new Map<string, Registration>()
  const requests: Array<{ method: string; path: string }> = []
  const effects: Array<() => unknown> = []
  const settingsDisposed = vi.fn()
  const configureSettings = vi.fn(() => settingsDisposed)
  const fiber = { config: { profileDir: paths.profileDir } }
  const context = {
    fiber,
    settings: { configure: configureSettings },
    webServer: {
      register(registration: Registration) {
        expect(registration.kind).toBe('exact')
        expect(registered.has(registration.path)).toBe(false)
        registered.set(registration.path, registration)
        return () => { registered.delete(registration.path) }
      },
    },
    inject(services: string[], callback: (ctx: unknown) => void) {
      expect(services).toHaveLength(1)
      expect(['settings', 'webServer']).toContain(services[0])
      callback(context)
    },
    effect(factory: () => unknown, _label: string) {
      const dispose = factory()
      if (typeof dispose === 'function') effects.push(dispose as () => unknown)
    },
  }
  let disposed = false
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    requests.push({ method: request.method ?? '', path })
    const route = registered.get(path)
    if (route === undefined) {
      response.writeHead(404)
      response.end('not found')
      return
    }
    void Promise.resolve(route.handler(request, response)).catch((error: unknown) => {
      response.writeHead(500)
      response.end(String(error))
    })
  })
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    for (const effect of effects.slice().reverse()) await effect()
    await close(server)
  }
  disposals.push(dispose)
  apply(context as unknown as Context, { profileDir: paths.profileDir })
  const port = await listen(server)
  return { port, registered, requests, dispose, configureSettings, settingsDisposed, fiber }
}

async function status(port: number): Promise<StatusResult> {
  const response = await ask(port, ROUTE_STATUS)
  expect(response.status).toBe(200)
  return JSON.parse(response.body) as StatusResult
}

async function save(port: number, body: ConfigureBody): Promise<void> {
  const response = await ask(port, ROUTE_CONFIG, { method: 'POST', body })
  expect(response.status).toBe(200)
  expect(JSON.parse(response.body)).toEqual({ message: '已保存' })
}

async function bed() {
  const paths = await writeProfile()
  const up = await upstream()
  const relayPort = await freePort()
  const running = await host(paths)
  // Settle the startup read before testing saves. No status read is allowed to
  // turn the listener on on behalf of the config POST below.
  await status(running.port)
  running.requests.length = 0
  const body: ConfigureBody = {
    url: `http://127.0.0.1:${up.port}/dav`, user: 'upstream-user',
    password: 'upstream-password', passphrase: 'backup-passphrase', headers: 'X-Proxy: shared',
    relayEnabled: true, relayPort,
  }
  return { paths, up, relayPort, running, body }
}

afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose()
  await Promise.all(sockets.splice(0).map(close))
  vi.restoreAllMocks()
  await cleanUp()
})

describe('the relay mounted by the host plugin', () => {
  it('starts listening on the one shared config save before any subsequent status read', async () => {
    const { paths, up, relayPort, running, body } = await bed()
    await save(running.port, body)
    const { config } = await loadConfig(paths)
    expect(config).toMatchObject(body)
    expect(config.relayUser).not.toBe(config.user)
    expect(config.relayPassword).not.toBe(config.password)
    expect(config.relayUser).not.toBe('')
    expect(config.relayPassword).not.toBe('')
    expect((await ask(relayPort, '/dav/private')).status).toBe(401)
    expect(up.seen).toEqual([])
    const answer = await ask(relayPort, '/dav/file.txt', {
      headers: { authorization: basic(config.relayUser, config.relayPassword) },
    })
    expect(answer).toEqual({ status: 200, body: 'upstream-response' })
    expect(up.seen).toEqual([expect.objectContaining({
      method: 'GET', url: '/dav/file.txt.prop',
      headers: expect.objectContaining({ authorization: basic('upstream-user', 'upstream-password'), 'x-proxy': 'shared' }),
    })])
    expect(running.requests).toEqual([{ method: 'POST', path: ROUTE_CONFIG }])
  })

  it('serves the independent local account in status without either upstream secret', async () => {
    const { paths, relayPort, running, body } = await bed()
    await save(running.port, body)
    const stored = (await loadConfig(paths)).config
    const view = await status(running.port)
    expect(view.config).toMatchObject({ relayEnabled: true, relayPort, passwordSet: true, passphraseSet: true })
    expect(view.relay).toEqual({
      enabled: true, port: relayPort, url: `http://127.0.0.1:${relayPort}/dav`,
      user: stored.relayUser, password: stored.relayPassword, listening: true, error: '',
    })
    expect(view.relay?.user).not.toBe(body.user)
    expect(view.relay?.password).not.toBe(body.password)
    for (const key of ['password', 'passphrase', 'relayUser', 'relayPassword']) expect(view.config).not.toHaveProperty(key)
    expect(JSON.stringify(view)).not.toContain('upstream-password')
    expect(JSON.stringify(view)).not.toContain('backup-passphrase')
  })

  it('rebuilds the relay with the in-memory upstream password after remembering is disabled', async () => {
    const { paths, up, relayPort, running, body } = await bed()
    await save(running.port, body)
    const original = (await loadConfig(paths)).config
    await save(running.port, { rememberPassword: false, password: '' })
    expect((await loadConfig(paths)).config).toMatchObject({
      password: '', rememberPassword: false, relayUser: original.relayUser, relayPassword: original.relayPassword,
    })
    expect(heldPassword(paths)).toBe('upstream-password')
    // /status creates another engine from disk. The secret must survive that
    // rebuild too, rather than merely work until the first browser poll.
    const view = await status(running.port)
    expect(view.config.passwordSet).toBe(true)
    expect(view.relay?.password).toBe(original.relayPassword)
    expect((await ask(relayPort, '/dav/after-poll', {
      headers: { authorization: basic(original.relayUser, original.relayPassword) },
    })).status).toBe(200)
    expect(up.seen.at(-1)?.headers.authorization).toBe(basic('upstream-user', 'upstream-password'))
    expect(up.seen.at(-1)?.headers['x-proxy']).toBe('shared')
  })

  it('closes the listener during off itself and retains the independent account', async () => {
    const { paths, relayPort, running, body } = await bed()
    await save(running.port, { ...body, rememberPassword: false })
    const original = (await loadConfig(paths)).config
    expect(heldPassword(paths)).toBe('upstream-password')
    const answer = await ask(running.port, ROUTE_OFF, { method: 'POST', body: {} })
    expect(answer.status).toBe(200)
    // Deliberately before /status: the off handler, not a later poll, owns this.
    await expect(ask(relayPort, '/dav/file', {
      headers: { authorization: basic(original.relayUser, original.relayPassword) },
    })).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    expect((await loadConfig(paths)).config).toMatchObject({
      url: '', password: '', relayUser: original.relayUser, relayPassword: original.relayPassword,
    })
    expect(heldPassword(paths)).toBeUndefined()
    expect((await status(running.port)).relay).toMatchObject({
      listening: false, user: original.relayUser, password: original.relayPassword,
    })
  })

  it('registers only the existing sync routes, with no independent relay control endpoint', async () => {
    const paths = await writeProfile()
    const running = await host(paths)
    expect([...running.registered.keys()].sort()).toEqual([
      ROUTE_STATUS, ROUTE_CONFIG, ROUTE_CHECK, ROUTE_SYNC, ROUTE_PREVIEW, ROUTE_RESTORE,
      ROUTE_UNDO, ROUTE_UPLOAD, ROUTE_DISMISS, ROUTE_OFF, ROUTE_INSTALL,
    ].sort())
    expect(running.configureSettings).toHaveBeenCalledExactlyOnceWith({ auto: false }, running.fiber)
    for (const suffix of ['relay', 'relay/config', 'relay/status']) {
      expect((await ask(running.port, `${ROUTE_CONFIG.slice(0, ROUTE_CONFIG.lastIndexOf('/'))}/${suffix}`)).status).toBe(404)
    }
  })

  it('starts from the saved sync.json before any host route or browser poll runs', async () => {
    const paths = await writeProfile()
    const up = await upstream()
    const relayPort = await freePort()
    const stored: SyncConfig = configFor({
      url: `http://127.0.0.1:${up.port}/dav`, user: 'persisted-user', password: 'persisted-password',
      headers: 'X-Proxy: persisted', relayEnabled: true, relayPort,
      relayUser: 'persisted-local-user', relayPassword: 'persisted-local-password',
    })
    await saveConfig(paths, stored)
    const running = await host(paths)
    await vi.waitFor(async () => {
      expect((await ask(relayPort, '/dav/startup', {
        headers: { authorization: basic(stored.relayUser, stored.relayPassword) },
      })).status).toBe(200)
    }, { timeout: 10_000, interval: 100 })
    expect(running.requests).toEqual([])
    expect(up.seen.at(-1)?.headers.authorization).toBe(basic('persisted-user', 'persisted-password'))
    expect(up.seen.at(-1)?.headers['x-proxy']).toBe('persisted')
    expect((await loadConfig(paths)).config).toEqual(stored)
  })

  it('disposes the active listener together with routes, settings policy, and timer', async () => {
    const { relayPort, running, body } = await bed()
    await save(running.port, body)
    expect((await ask(relayPort, '/dav')).status).toBe(401)
    await running.dispose()
    await vi.waitFor(async () => {
      await expect(ask(relayPort, '/dav')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    })
    expect(running.registered.size).toBe(0)
    expect(running.settingsDisposed).toHaveBeenCalledOnce()
    await expect(ask(running.port, ROUTE_STATUS)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('does not resurrect a listener when disposed during the startup config read', async () => {
    const paths = await writeProfile()
    const up = await upstream()
    const relayPort = await freePort()
    await saveConfig(paths, configFor({
      url: `http://127.0.0.1:${up.port}/dav`, relayEnabled: true, relayPort,
      relayUser: 'saved-local-user', relayPassword: 'saved-local-password',
    }))
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const read = engines.loadConfig
    const startup = vi.spyOn(engines, 'loadConfig').mockImplementationOnce(async (profile) => {
      await pending
      return read(profile)
    })
    const relayApply = vi.spyOn(RelayServer.prototype, 'apply')
    const running = await host(paths)
    expect(startup).toHaveBeenCalledOnce()
    await running.dispose()
    release()
    await startup.mock.results[0]?.value
    await settle()
    expect(relayApply).not.toHaveBeenCalled()
    await expect(ask(relayPort, '/dav')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })
})
