/**
 * The relay: the forwarder a WebDAV client on this computer can talk through
 * when it cannot set the request headers its server wants.
 *
 * Every case here is about the two things the relay must never do — change the
 * path a client asked for, or let the sync's configuration leak into its own —
 * and the one thing it exists to do: add the headers on the way past.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import {
  RelayServer,
  defaultRelay,
  loadRelay,
  makeRelayToken,
  normaliseRelay,
  saveRelay,
} from '../src/relay.ts'
import { resolveRelayPaths, resolvePaths } from '../src/paths.ts'
import { RELAY_DEFAULT_PORT, relayUrl } from '../src/wire.ts'
import { cleanUp, tempDir } from './harness.ts'

/** Servers to close after each case. */
const servers: Server[] = []

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()
    if (server === undefined) continue
    await new Promise<void>((settle) => {
      server.close(() => settle())
      server.closeAllConnections()
    }).catch(() => undefined)
  }
  await cleanUp()
})

/** One request, answered or refused, as the relay's client sees it. */
interface Answer {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

/** Send a request to a port and read the whole answer. */
function ask(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  return new Promise((settle, fail) => {
    const ask = httpRequest(
      { hostname: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: init.headers ?? {} },
      (answer) => {
        const chunks: Buffer[] = []
        answer.on('data', (chunk: Buffer) => chunks.push(chunk))
        answer.on('end', () => {
          settle({
            status: answer.statusCode ?? 0,
            headers: answer.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    ask.on('error', fail)
    if (init.body !== undefined) ask.write(init.body)
    ask.end()
  })
}

/** What the target server was asked, recorded as it arrives. */
interface Seen {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

/** A stand-in WebDAV server: records every request, answers `reply`. */
async function target(
  reply: (seen: Seen) => { status: number; headers?: Record<string, string>; body?: string } = () => ({ status: 200 }),
): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const one: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      seen.push(one)
      const answer = reply(one)
      res.writeHead(answer.status, answer.headers ?? {})
      res.end(answer.body ?? '')
    })
  })
  servers.push(server)
  await new Promise<void>((settle) => server.listen(0, '127.0.0.1', () => settle()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('测试服务器没有端口')
  return { port: address.port, seen }
}

/** A free port to listen on, released again before the relay takes it. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((settle) => server.listen(0, '127.0.0.1', () => settle()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('没有端口')
  await new Promise<void>((settle) => server.close(() => settle()))
  return address.port
}

/** A relay with a profile directory of its own. */
async function bed(): Promise<{ relay: RelayServer; dir: string; port: number }> {
  const dir = await tempDir()
  const relay = new RelayServer(() => resolveRelayPaths(dir))
  const port = await freePort()
  return { relay, dir, port }
}

describe('normaliseRelay', () => {
  it('rests off, with no target and no address', () => {
    expect(defaultRelay()).toEqual({
      enabled: false,
      port: RELAY_DEFAULT_PORT,
      token: '',
      target: '',
      headers: '',
    })
  })

  it('drops a token that is not one, and a port that is not a port', () => {
    const config = normaliseRelay({ enabled: true, port: 70_000, token: 'not-a-token', target: '  https://dav.test/dav  ' })
    expect(config.port).toBe(RELAY_DEFAULT_PORT)
    expect(config.token).toBe('')
    expect(config.target).toBe('https://dav.test/dav')
    expect(config.enabled).toBe(true)
  })

  it('keeps a token that is one', () => {
    const token = makeRelayToken()
    expect(normaliseRelay({ token }).token).toBe(token)
  })
})

describe('the relay file', () => {
  it('is not there until something is saved', async () => {
    const dir = await tempDir()
    const { config, found } = await loadRelay(resolveRelayPaths(dir))
    expect(found).toBe(false)
    expect(config.token).toBe('')
  })

  it('is written 0600 into its own directory', async () => {
    const dir = await tempDir()
    const paths = resolveRelayPaths(dir)
    await saveRelay(paths, { ...defaultRelay(), token: makeRelayToken(), target: 'https://dav.test/dav' })
    const written = await loadRelay(paths)
    expect(written.found).toBe(true)
    expect(written.config.target).toBe('https://dav.test/dav')
    if (process.platform !== 'win32') {
      expect((await stat(paths.file)).mode & 0o777).toBe(0o600)
    }
  })

  it('lives apart from everything the sync keeps', async () => {
    const dir = await tempDir()
    const relay = new RelayServer(() => resolveRelayPaths(dir))
    const port = await freePort()
    await relay.save({ enabled: true, target: 'https://dav.test/dav', port })
    await relay.stop()
    // The sync's own state directory must not have been created by any of this.
    await expect(stat(resolvePaths(dir).stateDir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readFile(resolveRelayPaths(dir).file, 'utf8')).length).toBeGreaterThan(0)
  })
})

describe('RelayServer.save', () => {
  it('mints an address on the first save and keeps it afterwards', async () => {
    const { relay, port } = await bed()
    const first = await relay.save({ target: 'https://dav.test/dav', port })
    expect(first.url).toBe(relayUrl(port, first.config.token))
    expect(first.config.token).toMatch(/^[0-9a-f]{32}$/)

    const second = await relay.save({ target: 'https://dav.test/other' })
    expect(second.config.token).toBe(first.config.token)
    expect(second.url).toBe(first.url)
  })

  it('mints a new address when asked, and only that', async () => {
    const { relay, port } = await bed()
    const first = await relay.save({ target: 'https://dav.test/dav', port })
    const second = await relay.save({ token: '' })
    expect(second.config.token).not.toBe(first.config.token)
    expect(second.config.target).toBe('https://dav.test/dav')
    expect(second.config.port).toBe(first.config.port)
  })

  it('refuses to listen with nowhere to forward to', async () => {
    const { relay } = await bed()
    await expect(relay.save({ enabled: true })).rejects.toThrow(/转发目标/)
  })

  it('refuses a target that is not an http address', async () => {
    const { relay } = await bed()
    await expect(relay.save({ enabled: true, target: 'ftp://dav.test/dav' })).rejects.toThrow(/http/)
  })

  it('refuses a port that is not one', async () => {
    const { relay } = await bed()
    await expect(relay.save({ port: 0 })).rejects.toThrow(/端口/)
  })

  it('refuses a header line that is not one, before writing anything', async () => {
    const { relay } = await bed()
    await expect(relay.save({ headers: 'not a header' })).rejects.toThrow(/请求头/)
  })

  it('reports a port already in use instead of throwing', async () => {
    const { relay } = await bed()
    const taken = createServer()
    servers.push(taken)
    await new Promise<void>((settle) => taken.listen(0, '127.0.0.1', () => settle()))
    const address = taken.address()
    if (address === null || typeof address === 'string') throw new Error('没有端口')

    const status = await relay.save({ enabled: true, target: 'https://dav.test/dav', port: address.port })
    expect(status.listening).toBe(false)
    expect(status.error).toMatch(/端口/)
  })
})

describe('forwarding', () => {
  it('hands the path over exactly, query and all', async () => {
    const server = await target()
    const { relay, port } = await bed()
    const status = await relay.save({
      enabled: true,
      target: `http://127.0.0.1:${server.port}/dav`,
      port,
    })

    const answer = await ask(port, `/${status.config.token}/magpie/magpie.magpie-backup?x=1&y=2`, {
      method: 'PUT',
      body: 'hello',
    })
    expect(answer.status).toBe(200)
    expect(server.seen).toHaveLength(1)
    expect(server.seen[0]!.method).toBe('PUT')
    expect(server.seen[0]!.url).toBe('/dav/magpie/magpie.magpie-backup?x=1&y=2')
    expect(server.seen[0]!.body).toBe('hello')
    await relay.stop()
  })

  it('adds the configured headers, and a client header wins the collision', async () => {
    const server = await target()
    const { relay, port } = await bed()
    const status = await relay.save({
      enabled: true,
      target: `http://127.0.0.1:${server.port}/dav`,
      port,
      headers: 'User-Agent: Zotero/7.0\nX-From-Relay: yes\nX-Both: configured',
    })

    await ask(port, `/${status.config.token}/x`, { headers: { 'x-both': 'client', 'x-client': 'kept' } })
    const seen = server.seen[0]!
    expect(seen.headers['user-agent']).toBe('Zotero/7.0')
    expect(seen.headers['x-from-relay']).toBe('yes')
    expect(seen.headers['x-both']).toBe('client')
    expect(seen.headers['x-client']).toBe('kept')
    await relay.stop()
  })

  it('lets a configured authorization win over the client’s', async () => {
    const server = await target()
    const { relay, port } = await bed()
    const status = await relay.save({
      enabled: true,
      target: `http://127.0.0.1:${server.port}/dav`,
      port,
      headers: 'Authorization: Bearer configured',
    })

    await ask(port, `/${status.config.token}/x`, { headers: { authorization: 'Bearer client' } })
    expect(server.seen[0]!.headers.authorization).toBe('Bearer configured')
    await relay.stop()
  })

  it('keeps the client’s authorization when none was configured', async () => {
    const server = await target()
    const { relay, port } = await bed()
    const status = await relay.save({ enabled: true, target: `http://127.0.0.1:${server.port}/dav`, port })

    await ask(port, `/${status.config.token}/x`, { headers: { authorization: 'Bearer client' } })
    expect(server.seen[0]!.headers.authorization).toBe('Bearer client')
    await relay.stop()
  })

  it('does not pass connection-level headers on, and rewrites the host', async () => {
    const server = await target()
    const { relay, port } = await bed()
    const status = await relay.save({ enabled: true, target: `http://127.0.0.1:${server.port}/dav`, port })

    await ask(port, `/${status.config.token}/x`, { headers: { connection: 'keep-alive' } })
    const seen = server.seen[0]!
    // The client addressed the relay; the server must be addressed as itself.
    expect(seen.headers.host).toBe(`127.0.0.1:${server.port}`)
    // The relay invents no forwarding headers of its own.
    expect(seen.headers['x-forwarded-for']).toBeUndefined()
    await relay.stop()
  })

  it('answers 404 to a caller that does not know the address, and forwards nothing', async () => {
    const server = await target()
    const { relay, port } = await bed()
    await relay.save({ enabled: true, target: `http://127.0.0.1:${server.port}/dav`, port })

    const wrong = await ask(port, `/${'0'.repeat(32)}/x`)
    expect(wrong.status).toBe(404)
    expect(server.seen).toHaveLength(0)
    await relay.stop()
  })

  it('takes one doubled slash off the seam and leaves the rest alone', async () => {
    const server = await target()
    const { relay, port } = await bed()
    const status = await relay.save({ enabled: true, target: `http://127.0.0.1:${server.port}/dav`, port })

    await ask(port, `/${status.config.token}//magpie/x`)
    expect(server.seen[0]!.url).toBe('/dav/magpie/x')
    await relay.stop()
  })

  it('points a redirect back at the relay, not at the server', async () => {
    const server = await target((seen) =>
      seen.url.startsWith('/dav/old')
        ? { status: 301, headers: { location: `http://${seen.headers.host}/dav/new/path` } }
        : { status: 200 },
    )
    const { relay, port } = await bed()
    const status = await relay.save({ enabled: true, target: `http://127.0.0.1:${server.port}/dav`, port })

    const answer = await ask(port, `/${status.config.token}/old`)
    expect(answer.status).toBe(301)
    expect(answer.headers.location).toBe(`${relayUrl(port, status.config.token)}/new/path`)
    await relay.stop()
  })

  it('carries the server’s answer back untouched', async () => {
    const server = await target(() => ({ status: 207, headers: { 'x-mark': 'kept' }, body: 'a body' }))
    const { relay, port } = await bed()
    const status = await relay.save({ enabled: true, target: `http://127.0.0.1:${server.port}/dav`, port })

    const answer = await ask(port, `/${status.config.token}/x`)
    expect(answer.status).toBe(207)
    expect(answer.headers['x-mark']).toBe('kept')
    expect(answer.body).toBe('a body')
    await relay.stop()
  })

  it('stops listening when it is switched off, and says so', async () => {
    const server = await target()
    const { relay, port } = await bed()
    await relay.save({ enabled: true, target: `http://127.0.0.1:${server.port}/dav`, port })
    const off = await relay.save({ enabled: false })
    expect(off.listening).toBe(false)
    await expect(ask(port, '/anything')).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })
})

describe('RelayServer.start', () => {
  it('picks up a saved configuration', async () => {
    const dir = await tempDir()
    const port = await freePort()
    const server = await target()
    await mkdir(resolveRelayPaths(dir).dir, { recursive: true })
    await saveRelay(resolveRelayPaths(dir), {
      enabled: true,
      port,
      token: makeRelayToken(),
      target: `http://127.0.0.1:${server.port}/dav`,
      headers: 'X-Seeded: yes',
    })

    const relay = new RelayServer(() => resolveRelayPaths(dir))
    await relay.start()
    const status = await relay.status()
    expect(status.listening).toBe(true)
    await ask(port, `/${status.config.token}/x`)
    expect(server.seen[0]!.headers['x-seeded']).toBe('yes')
    await relay.stop()
  })

  it('follows a profile directory that moves under it', async () => {
    const first = await tempDir()
    const second = await tempDir()
    const port = await freePort()
    let dir = first
    const relay = new RelayServer(() => resolveRelayPaths(dir))
    await relay.start()
    expect((await relay.status()).config.token).toBe('')

    dir = second
    await mkdir(resolveRelayPaths(second).dir, { recursive: true })
    await writeFile(
      resolveRelayPaths(second).file,
      JSON.stringify({ enabled: false, port, token: makeRelayToken(), target: 'https://dav.test/dav', headers: '' }),
      'utf8',
    )
    const status = await relay.status()
    expect(status.config.target).toBe('https://dav.test/dav')
    expect(status.file).toBe(resolveRelayPaths(second).file)
    await relay.stop()
  })

  it('reports a file it cannot read instead of taking the host down', async () => {
    const dir = await tempDir()
    const paths = resolveRelayPaths(dir)
    await mkdir(paths.dir, { recursive: true })
    await writeFile(paths.file, '{ not json', 'utf8')

    const relay = new RelayServer(() => resolveRelayPaths(dir))
    await relay.start()
    const status = await relay.status()
    expect(status.listening).toBe(false)
    expect(status.error).toMatch(/JSON/)
  })
})

describe('the address', () => {
  it('is loopback and carries the token', async () => {
    const { relay, port } = await bed()
    const status = await relay.save({ target: 'https://dav.test/dav', port })
    expect(status.url).toBe(`http://127.0.0.1:${port}/${status.config.token}`)
  })

  it('is empty until a first save', async () => {
    const dir = await tempDir()
    const relay = new RelayServer(() => resolveRelayPaths(dir))
    const status = await relay.status()
    expect(status.url).toBe('')
    // Nothing was written to earn that address: a plugin nobody uses leaves no
    // file behind.
    await expect(stat(resolveRelayPaths(dir).file)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
