/**
 * The forwarder: the door a WebDAV client on this computer comes in by.
 *
 * It is a switch on the sync's own configuration, so every case here is about one
 * of three things — that it opens only when the configuration is complete, that
 * only the account it minted may come through it, and that what it passes on is
 * the client's own request with the configured address, account and headers
 * standing behind it. Nothing about the sync itself is involved: the forwarder
 * reads a configuration and never writes one.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { RelayServer, makeRelayPassword, makeRelayUser } from '../src/relay.ts'
import { configFor } from './harness.ts'
import { RELAY_DEFAULT_PORT, RELAY_PASSWORD_BYTES, RELAY_USER_BYTES, relayUrl, type SyncConfig } from '../src/wire.ts'

// ---------------------------------------------------------------------------
// The two ends of one forwarded request
// ---------------------------------------------------------------------------

/** One request as the server behind the forwarder saw it. */
interface Seen {
  method: string
  url: string
  headers: IncomingHttpHeaders
  body: string
}

/** What the fake server answers with. */
interface Reply {
  status?: number
  headers?: Record<string, string>
  body?: string
}

/** A server standing in for the real WebDAV one, which records what it was asked. */
interface Upstream {
  port: number
  seen: Seen[]
  close(): Promise<void>
}

async function upstream(answer?: (seen: Seen) => Reply): Promise<Upstream> {
  const seen: Seen[] = []
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const record: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }
      seen.push(record)
      const reply = answer?.(record) ?? {}
      res.writeHead(reply.status ?? 200, reply.headers ?? {})
      res.end(reply.body ?? 'ok')
    })
  })
  await new Promise<void>((settle) => server.listen(0, '127.0.0.1', () => settle()))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    seen,
    close: () =>
      new Promise<void>((settle) => {
        server.close(() => settle())
        server.closeAllConnections()
      }),
  }
}

/** One answer as the client saw it. */
interface Answer {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

/** Ask the forwarder for one thing, as a WebDAV client would. */
function ask(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  return new Promise<Answer>((settle, fail) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        // A socket of its own every time: a refused connection must refuse now,
        // rather than be a pooled one that happened to still be open.
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          settle({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    request.on('error', fail)
    request.end(options.body)
  })
}

/** The Basic line a client signs in with. */
function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`
}

/** A port nothing is listening on. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((settle) => server.listen(0, '127.0.0.1', () => settle()))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((settle) => server.close(() => settle()))
  return port
}

const relays: RelayServer[] = []
const servers: Upstream[] = []
const held: Server[] = []
const stateDirs: string[] = []

/** A forwarder that is stopped again at the end of the case. */
function relay(): RelayServer {
  const made = new RelayServer()
  relays.push(made)
  return made
}

/** A fake server closed at the end of the case. */
async function server(answer?: (seen: Seen) => Reply): Promise<Upstream> {
  const made = await upstream(answer)
  servers.push(made)
  return made
}

/** A socket held open, for a port that is taken. */
async function heldPort(): Promise<number> {
  const socket = createServer()
  await new Promise<void>((settle) => socket.listen(0, '127.0.0.1', () => settle()))
  held.push(socket)
  return (socket.address() as AddressInfo).port
}

afterEach(async () => {
  await Promise.all(relays.splice(0).map((one) => one.stop()))
  await Promise.all(stateDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  await Promise.all(servers.splice(0).map((one) => one.close()))
  await Promise.all(
    held.splice(0).map(
      (socket) =>
        new Promise<void>((settle) => {
          socket.close(() => settle())
          socket.closeAllConnections()
        }),
    ),
  )
})

/** A forwarder switched on and pointed at a fake server, with an account of its own. */
async function bed(over: Partial<SyncConfig> = {}): Promise<{ relay: RelayServer; port: number; up: Upstream }> {
  const up = await server()
  const port = await freePort()
  const made = relay()
  await made.apply(
    configFor({
      url: `http://127.0.0.1:${up.port}/dav`,
      relayEnabled: true,
      relayPort: port,
      relayUser: 'dsh0001',
      relayPassword: 'a relay secret',
      ...over,
    }),
  )
  return { relay: made, port, up }
}

// ---------------------------------------------------------------------------

describe('the account it hands out', () => {
  it('names a client with a short hex name, and never the same one twice', () => {
    const first = makeRelayUser()
    const second = makeRelayUser()
    expect(first).toMatch(new RegExp(`^dsh[0-9a-f]{${RELAY_USER_BYTES * 2}}$`))
    expect(second).not.toBe(first)
  })

  it('gives it a password long enough not to be guessed', () => {
    const first = makeRelayPassword()
    expect(first).toMatch(new RegExp(`^[0-9a-f]{${RELAY_PASSWORD_BYTES * 2}}$`))
    expect(makeRelayPassword()).not.toBe(first)
  })
})

describe('the switch', () => {
  it('rests off, with nothing listening and no address to hand out', async () => {
    const port = await freePort()
    const made = relay()
    await made.apply(configFor({ relayEnabled: false, relayPort: port }))
    expect(made.view()).toEqual({
      enabled: false,
      port,
      url: '',
      user: '',
      password: '',
      listening: false,
      error: '',
    })
    await expect(ask(port, '/')).rejects.toThrow()
  })

  it('will not open without an address to forward to', async () => {
    const port = await freePort()
    const made = relay()
    await made.apply(configFor({ url: '', relayEnabled: true, relayPort: port, relayUser: 'dsh1', relayPassword: 'p' }))
    expect(made.view().listening).toBe(false)
    expect(made.view().error).toMatch(/地址/)
    await expect(ask(port, '/')).rejects.toThrow()
  })

  it('will not open on an address that is not one', async () => {
    const port = await freePort()
    const made = relay()
    await made.apply(configFor({ url: 'dav.test/dav', relayEnabled: true, relayPort: port, relayUser: 'dsh1', relayPassword: 'p' }))
    expect(made.view().listening).toBe(false)
    expect(made.view().error).toMatch(/不是地址/)
  })

  it('will not open on an address that is not WebDAV over http', async () => {
    const port = await freePort()
    const made = relay()
    await made.apply(configFor({ url: 'ftp://dav.test/dav', relayEnabled: true, relayPort: port, relayUser: 'dsh1', relayPassword: 'p' }))
    expect(made.view().listening).toBe(false)
    expect(made.view().error).toMatch(/http/)
  })

  it('will not open without the account a client is to sign in with', async () => {
    // Only reachable by editing `sync.json` by hand — and then the safe answer is
    // no door at all, rather than one anybody on this computer may walk through.
    const port = await freePort()
    const made = relay()
    await made.apply(configFor({ relayEnabled: true, relayPort: port, relayUser: '', relayPassword: '' }))
    expect(made.view().listening).toBe(false)
    expect(made.view().error).toMatch(/账号/)
    await expect(ask(port, '/')).rejects.toThrow()
  })

  it('opens on loopback and hands out the address the client is given', async () => {
    const { relay: made, port } = await bed()
    const view = made.view()
    expect(view.listening).toBe(true)
    expect(view.enabled).toBe(true)
    expect(view.url).toBe(relayUrl(port, '/dav'))
    expect(view.user).toBe('dsh0001')
    expect(view.password).toBe('a relay secret')
    expect(view.error).toBe('')
  })

  it('gives the address the target’s own base path, so the rest of it means the same thing', async () => {
    const up = await server()
    const port = await freePort()
    const made = relay()
    await made.apply(
      configFor({ url: `http://127.0.0.1:${up.port}/dav/`, relayEnabled: true, relayPort: port, relayUser: 'dsh1', relayPassword: 'p' }),
    )
    expect(made.view().url).toBe(`http://127.0.0.1:${port}/dav`)
  })

  it('hands out a bare address when the target has no path of its own', async () => {
    const up = await server()
    const port = await freePort()
    const made = relay()
    await made.apply(configFor({ url: `http://127.0.0.1:${up.port}`, relayEnabled: true, relayPort: port, relayUser: 'dsh1', relayPassword: 'p' }))
    expect(made.view().url).toBe(`http://127.0.0.1:${port}`)
  })

  it('closes the door when it is switched off again', async () => {
    const { relay: made, port, up } = await bed()
    expect((await ask(port, '/dav/a', { headers: { authorization: basic('dsh0001', 'a relay secret') } })).status).toBe(200)
    await made.apply(configFor({ url: `http://127.0.0.1:${up.port}/dav`, relayEnabled: false, relayPort: port }))
    expect(made.view().listening).toBe(false)
    await expect(ask(port, '/dav/a')).rejects.toThrow()
  })

  it('reports a port already in use instead of throwing, and stays shut', async () => {
    const taken = await heldPort()
    const up = await server()
    const made = relay()
    await made.apply(
      configFor({ url: `http://127.0.0.1:${up.port}/dav`, relayEnabled: true, relayPort: taken, relayUser: 'dsh1', relayPassword: 'p' }),
    )
    const view = made.view()
    expect(view.listening).toBe(false)
    expect(view.error).toMatch(/端口/)
    expect(view.error).toMatch(/EADDRINUSE|address already in use/i)
  })

  it('follows the port when it is moved', async () => {
    const { relay: made, port, up } = await bed()
    const moved = await freePort()
    await made.apply(
      configFor({
        url: `http://127.0.0.1:${up.port}/dav`,
        relayEnabled: true,
        relayPort: moved,
        relayUser: 'dsh0001',
        relayPassword: 'a relay secret',
      }),
    )
    expect(made.view().port).toBe(moved)
    expect(made.view().listening).toBe(true)
    await expect(ask(port, '/dav/a')).rejects.toThrow()
    const answer = await ask(moved, '/dav/a', { headers: { authorization: basic('dsh0001', 'a relay secret') } })
    expect(answer.status).toBe(200)
  })

  it('leaves a socket that is already right alone', async () => {
    const { relay: made, port } = await bed()
    await made.apply(
      configFor({ url: 'http://127.0.0.1:1/dav', relayEnabled: true, relayPort: port, relayUser: 'dsh0001', relayPassword: 'a relay secret' }),
    )
    expect(made.view().listening).toBe(true)
    expect(made.view().port).toBe(port)
  })

  it('serialises overlapping reads and a stop, without leaving a listener behind', async () => {
    const up = await server()
    const port = await freePort()
    const made = relay()
    const config = configFor({ url: `http://127.0.0.1:${up.port}/dav`, relayEnabled: true, relayPort: port, relayUser: 'u', relayPassword: 'p' })
    await Promise.all([made.apply(config), made.apply(config), made.stop()])
    expect(made.view().listening).toBe(false)
    await expect(ask(port, '/')).rejects.toThrow()
    await made.apply(config)
    expect(made.view().listening).toBe(true)
    expect(made.view().error).toBe('')
  })

  it('closes rather than letting a malformed hand-edited header crash a request', async () => {
    const { relay: made, port, up } = await bed()
    await made.apply(configFor({ url: `http://127.0.0.1:${up.port}/dav`, relayEnabled: true, relayPort: port, relayUser: 'u', relayPassword: 'p', headers: 'not a header' }))
    expect(made.view().listening).toBe(false)
    expect(made.view().error).toMatch(/请求头/)
    await expect(ask(port, '/')).rejects.toThrow()
  })

  it('rejects a header value that node cannot send before accepting requests', async () => {
    const { relay: made, port, up } = await bed()
    await made.apply(configFor({ url: `http://127.0.0.1:${up.port}/dav`, relayEnabled: true, relayPort: port, relayUser: 'u', relayPassword: 'p', headers: 'X-Bad: a\u0000b' }))
    expect(made.view().listening).toBe(false)
    expect(made.view().error).not.toBe('')
  })

  it('defaults to a port next to the gateway’s own', () => {
    expect(RELAY_DEFAULT_PORT).toBe(3426)
    expect(configFor().relayPort).toBe(RELAY_DEFAULT_PORT)
  })
})

describe('who may come in', () => {
  it('turns a caller away with no credential, and asks for one', async () => {
    const { port, up } = await bed()
    const answer = await ask(port, '/dav/a')
    expect(answer.status).toBe(401)
    expect(answer.headers['www-authenticate']).toMatch(/^Basic /)
    expect(up.seen).toHaveLength(0)
  })

  it('turns away the wrong name, and the wrong password, and says the same thing either time', async () => {
    const { port, up } = await bed()
    const wrongName = await ask(port, '/dav/a', { headers: { authorization: basic('someone-else', 'a relay secret') } })
    const wrongPassword = await ask(port, '/dav/a', { headers: { authorization: basic('dsh0001', 'not it') } })
    expect(wrongName.status).toBe(401)
    expect(wrongPassword.status).toBe(401)
    expect(wrongName.body).toBe(wrongPassword.body)
    expect(up.seen).toHaveLength(0)
  })

  it('turns away a credential that is not Basic at all', async () => {
    const { port, up } = await bed()
    expect((await ask(port, '/dav/a', { headers: { authorization: 'Bearer whatever' } })).status).toBe(401)
    expect(up.seen).toHaveLength(0)
  })

  it('lets the minted account through, and signs in to the server as the sync does', async () => {
    const { port, up } = await bed({ user: 'dav-user', password: 'dav-secret' })
    const answer = await ask(port, '/dav/a', { headers: { authorization: basic('dsh0001', 'a relay secret') } })
    expect(answer.status).toBe(200)
    expect(up.seen[0]?.headers.authorization).toBe(basic('dav-user', 'dav-secret'))
  })

  it('never lets the client’s own credential reach the server', async () => {
    // The client's credential was addressed to the forwarder. With no account
    // configured for the server, nothing at all is passed on.
    const { port, up } = await bed({ user: '', password: '' })
    const answer = await ask(port, '/dav/a', { headers: { authorization: basic('dsh0001', 'a relay secret') } })
    expect(answer.status).toBe(200)
    expect(up.seen[0]?.headers.authorization).toBeUndefined()
  })
})

describe('the way through', () => {
  it('hands over the path, the query, the method and the body as they arrived', async () => {
    const { port, up } = await bed()
    const answer = await ask(port, '/dav/a%20b/c?x=1&y=2', {
      method: 'PUT',
      headers: { authorization: basic('dsh0001', 'a relay secret'), 'content-type': 'text/plain' },
      body: 'hello',
    })
    expect(answer.status).toBe(200)
    expect(up.seen[0]?.method).toBe('PUT')
    expect(up.seen[0]?.url).toBe('/dav/a%20b/c.prop?x=1&y=2')
    expect(up.seen[0]?.body).toBe('hello')
  })

  it('maps extensionless file resources to .prop and keeps allowed extensions', async () => {
    const { port, up } = await bed()
    const auth = { authorization: basic('dsh0001', 'a relay secret') }
    await ask(port, '/dav/backup', { method: 'PUT', headers: auth, body: 'prop' })
    await ask(port, '/dav/backup', { method: 'GET', headers: auth })
    await ask(port, '/dav/archive.zip', { method: 'PUT', headers: auth, body: 'zip' })
    await ask(port, '/dav/archive.prop', { method: 'PUT', headers: auth, body: 'prop' })
    await ask(port, '/dav/archive%2Ezip', { method: 'PUT', headers: auth, body: 'encoded zip' })
    await ask(port, '/dav/folder', { method: 'MKCOL', headers: auth })
    await ask(port, '/dav/folder/', { method: 'PROPFIND', headers: { ...auth, depth: '1' } })
    expect(up.seen.map(({ method, url }) => [method, url])).toEqual([
      ['PUT', '/dav/backup.prop'],
      ['GET', '/dav/backup.prop'],
      ['PUT', '/dav/archive.zip'],
      ['PUT', '/dav/archive.prop'],
      ['PUT', '/dav/archive%2Ezip'],
      ['MKCOL', '/dav/folder'],
      ['PROPFIND', '/dav/folder/'],
    ])
  })

  it('restores only relay-added suffixes in PROPFIND after restart', async () => {
    const up = await server((seen) => seen.method === 'PROPFIND'
      ? {
          status: 207,
          headers: { 'content-type': 'application/xml; charset=utf-8' },
          body: '<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/backup.prop?token=a&amp;b</D:href></D:response><D:response><D:href>backup.prop?token=a&amp;b</D:href></D:response><D:response><D:href>/dav/native.prop</D:href></D:response></D:multistatus>',
        }
      : {})
    const port = await freePort()
    const stateDir = await mkdtemp(join(tmpdir(), 'dsh-webdav-relay-'))
    stateDirs.push(stateDir)
    const config = configFor({
      url: `http://127.0.0.1:${up.port}/dav`,
      relayEnabled: true,
      relayPort: port,
      relayUser: 'dsh0001',
      relayPassword: 'a relay secret',
    })
    const first = relay()
    await first.apply(config, stateDir)
    const auth = { authorization: basic('dsh0001', 'a relay secret') }
    await ask(port, '/dav/backup', { method: 'PUT', headers: auth, body: 'data' })
    await ask(port, '/dav/native.prop', { method: 'PUT', headers: auth, body: 'data' })
    await first.stop()

    const restarted = relay()
    await restarted.apply(config, stateDir)
    const listing = await ask(port, '/dav/', { method: 'PROPFIND', headers: { ...auth, depth: '1' } })
    expect(listing.status).toBe(207)
    expect(listing.body).toContain('/dav/backup?token=a&amp;b')
    expect(listing.body).toContain('<D:href>backup?token=a&amp;b</D:href>')
    expect(listing.body).toContain('/dav/native.prop')
    expect(listing.body).not.toContain('/dav/backup.prop')

    await ask(port, '/dav/backup.prop', { method: 'PUT', headers: auth, body: 'native name' })
    const nativeListing = await ask(port, '/dav/', { method: 'PROPFIND', headers: { ...auth, depth: '1' } })
    expect(nativeListing.body).toContain('/dav/backup.prop')
  })

  it('keeps directory PROPFIND paths unchanged and maps explicit file probes', async () => {
    const { port, up } = await bed()
    const auth = { authorization: basic('dsh0001', 'a relay secret') }
    await ask(port, '/dav', { method: 'PROPFIND', headers: auth })
    await ask(port, '/dav', { method: 'OPTIONS', headers: auth })
    await ask(port, '/dav/item', { method: 'PROPFIND', headers: auth })
    await ask(port, '/dav/folder', { method: 'PROPFIND', headers: { ...auth, depth: '0' } })
    await ask(port, '/dav/backup.back', { method: 'PROPFIND', headers: { ...auth, depth: '0' } })
    expect(up.seen.map(({ method, url }) => [method, url])).toEqual([
      ['PROPFIND', '/dav/'],
      ['OPTIONS', '/dav'],
      ['PROPFIND', '/dav/item'],
      ['PROPFIND', '/dav/folder'],
      ['PROPFIND', '/dav/backup.back.prop'],
    ])
  })

  it('maps MOVE and COPY destinations and maintains file aliases', async () => {
    const up = await server((seen) => seen.method === 'PROPFIND'
      ? {
          status: 207,
          headers: { 'content-type': 'application/xml; charset=utf-8' },
          body: '<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/source.back.prop</D:href></D:response><D:response><D:href>/dav/moved.back.prop</D:href></D:response><D:response><D:href>/dav/copied.back.prop</D:href></D:response></D:multistatus>',
        }
      : { status: 201 })
    const port = await freePort()
    const made = relay()
    await made.apply(configFor({
      url: `http://127.0.0.1:${up.port}/dav`,
      relayEnabled: true,
      relayPort: port,
      relayUser: 'dsh0001',
      relayPassword: 'a relay secret',
    }))
    const auth = { authorization: basic('dsh0001', 'a relay secret') }
    await ask(port, '/dav/source.back', {
      method: 'COPY',
      headers: { ...auth, destination: `http://127.0.0.1:${port}/dav/copied.back` },
    })
    await ask(port, '/dav/source.back', {
      method: 'MOVE',
      headers: { ...auth, destination: `http://127.0.0.1:${port}/dav/moved.back` },
    })
    expect(up.seen.map(({ method, url, headers }) => [method, url, headers.destination])).toEqual([
      ['COPY', '/dav/source.back.prop', `http://127.0.0.1:${up.port}/dav/copied.back.prop`],
      ['MOVE', '/dav/source.back.prop', `http://127.0.0.1:${up.port}/dav/moved.back.prop`],
    ])
    const listing = await ask(port, '/dav/', { method: 'PROPFIND', headers: { ...auth, depth: '1' } })
    expect(listing.body).toContain('/dav/moved.back')
    expect(listing.body).toContain('/dav/copied.back')
    expect(listing.body).toContain('/dav/source.back.prop')
    expect(listing.body).not.toContain('/dav/moved.back.prop')
    expect(listing.body).not.toContain('/dav/copied.back.prop')
  })

  it('gives the base path to a client that dropped it, and not to one that kept it', async () => {
    const { port, up } = await bed()
    const auth = { authorization: basic('dsh0001', 'a relay secret') }
    await ask(port, '/a/b', { headers: auth })
    await ask(port, '/dav/a/b', { headers: auth })
    expect(up.seen.map((seen) => seen.url)).toEqual(['/dav/a/b.prop', '/dav/a/b.prop'])
  })

  it('answers a request for the root with the target’s own base', async () => {
    const { port, up } = await bed()
    await ask(port, '/', { headers: { authorization: basic('dsh0001', 'a relay secret') } })
    expect(up.seen[0]?.url).toBe('/dav/')
  })

  it('passes a path through untouched when the target has no base path', async () => {
    const up = await server()
    const port = await freePort()
    const made = relay()
    await made.apply(
      configFor({ url: `http://127.0.0.1:${up.port}`, relayEnabled: true, relayPort: port, relayUser: 'dsh1', relayPassword: 'p' }),
    )
    await ask(port, '/magpie/magpie.magpie-backup', { headers: { authorization: basic('dsh1', 'p') } })
    expect(up.seen[0]?.url).toBe('/magpie/magpie.magpie-backup.prop')
  })

  it('takes one doubled slash off the seam and leaves the rest alone', async () => {
    const { port, up } = await bed()
    const auth = { authorization: basic('dsh0001', 'a relay secret') }
    await ask(port, '//a', { headers: auth })
    await ask(port, '/dav//a', { headers: auth })
    expect(up.seen.map((seen) => seen.url)).toEqual(['/dav/a.prop', '/dav//a.prop'])
  })

  it('adds the configured headers, and a client header wins the collision', async () => {
    const { port, up } = await bed({ headers: 'X-From-Relay: yes\nX-Both: configured\nX-Only: relay' })
    await ask(port, '/dav/a', {
      method: 'PUT',
      headers: { authorization: basic('dsh0001', 'a relay secret'), 'content-type': 'application/octet-stream', 'x-both': 'client', 'x-client': 'mine' },
      body: 'payload',
    })
    const seen = up.seen[0]?.headers ?? {}
    expect(seen['x-from-relay']).toBe('yes')
    expect(seen['x-only']).toBe('relay')
    expect(seen['x-both']).toBe('client')
    expect(seen['x-client']).toBe('mine')
    expect(seen['content-type']).toBe('application/octet-stream')
  })

  it('lets a hand-written authorization in the configuration win, since it is the more specific word', async () => {
    const { port, up } = await bed({ user: 'dav-user', password: 'dav-secret', headers: 'Authorization: Bearer a-token' })
    await ask(port, '/dav/a', { headers: { authorization: basic('dsh0001', 'a relay secret') } })
    expect(up.seen[0]?.headers.authorization).toBe('Bearer a-token')
  })

  it('does not pass connection-level headers on, and addresses the server as itself', async () => {
    const { port, up } = await bed()
    await ask(port, '/dav/a', {
      headers: {
        authorization: basic('dsh0001', 'a relay secret'),
        host: 'somewhere.else.example',
        te: 'trailers',
        upgrade: 'h2c',
        'proxy-authorization': 'Basic cHJveHk=',
        connection: 'keep-alive',
      },
    })
    const seen = up.seen[0]?.headers ?? {}
    expect(seen.host).toBe(`127.0.0.1:${up.port}`)
    expect(seen.te).toBeUndefined()
    expect(seen.upgrade).toBeUndefined()
    expect(seen['proxy-authorization']).toBeUndefined()
  })

  it('filters configured host and connection headers as well as client-nominated fields', async () => {
    const { port, up } = await bed({ headers: 'Host: wrong.example\nConnection: x-config-hop\nX-Config-Hop: private\nTE: trailers\nX-Keep: yes' })
    await ask(port, '/dav/a', { headers: { authorization: basic('dsh0001', 'a relay secret'), connection: 'x-client-hop', 'x-client-hop': 'private' } })
    const headers = up.seen[0]?.headers ?? {}
    expect(headers.host).toBe(`127.0.0.1:${up.port}`)
    expect(headers['x-config-hop']).toBeUndefined()
    expect(headers['x-client-hop']).toBeUndefined()
    expect(headers.te).toBeUndefined()
    expect(headers['x-keep']).toBe('yes')
  })

  it('carries the server’s answer back untouched', async () => {
    const up = await server(() => ({ status: 207, headers: { 'content-type': 'application/xml', 'x-server': 'real' }, body: '<multistatus/>' }))
    const port = await freePort()
    const made = relay()
    await made.apply(
      configFor({ url: `http://127.0.0.1:${up.port}/dav`, relayEnabled: true, relayPort: port, relayUser: 'dsh1', relayPassword: 'p' }),
    )
    const answer = await ask(port, '/dav/a', { headers: { authorization: basic('dsh1', 'p') } })
    expect(answer.status).toBe(207)
    expect(answer.headers['content-type']).toBe('application/xml')
    expect(answer.headers['x-server']).toBe('real')
    expect(answer.body).toBe('<multistatus/>')
  })

  it('drops the connection-level headers of the answer', async () => {
    const up = await server(() => ({ status: 200, headers: { 'keep-alive': 'timeout=5', connection: 'x-hop', 'x-hop': 'private', 'x-kept': 'yes' } }))
    const port = await freePort()
    const made = relay()
    await made.apply(
      configFor({ url: `http://127.0.0.1:${up.port}/dav`, relayEnabled: true, relayPort: port, relayUser: 'dsh1', relayPassword: 'p' }),
    )
    const answer = await ask(port, '/dav/a', { headers: { authorization: basic('dsh1', 'p') } })
    expect(answer.headers['x-kept']).toBe('yes')
    expect(answer.headers['keep-alive']).toBeUndefined()
    expect(answer.headers['x-hop']).toBeUndefined()
  })

  it('points a redirect at the real server back at itself', async () => {
    // Left alone, the client would follow it straight to the server and from then
    // on talk around the forwarder, losing the account and the headers.
    const up = await server((seen) =>
      seen.url.startsWith('/dav/old')
        ? { status: 301, headers: { location: `http://${seen.headers.host}/dav/new/path` } }
        : { status: 200 },
    )
    const port = await freePort()
    const made = relay()
    await made.apply(
      configFor({ url: `http://127.0.0.1:${up.port}/dav`, relayEnabled: true, relayPort: port, relayUser: 'dsh1', relayPassword: 'p' }),
    )
    const answer = await ask(port, '/dav/old', { headers: { authorization: basic('dsh1', 'p') } })
    expect(answer.status).toBe(301)
    expect(answer.headers.location).toBe(`http://127.0.0.1:${port}/dav/new/path`)
  })

  it('points a path-only redirect at itself too', async () => {
    const up = await server(() => ({ status: 302, headers: { location: '/dav/new' } }))
    const port = await freePort()
    const made = relay()
    await made.apply(
      configFor({ url: `http://127.0.0.1:${up.port}/dav`, relayEnabled: true, relayPort: port, relayUser: 'dsh1', relayPassword: 'p' }),
    )
    const answer = await ask(port, '/dav/old', { headers: { authorization: basic('dsh1', 'p') } })
    expect(answer.headers.location).toBe(`http://127.0.0.1:${port}/dav/new`)
  })

  it('leaves a redirect that goes somewhere else alone', async () => {
    const up = await server(() => ({ status: 302, headers: { location: 'https://elsewhere.example/x' } }))
    const port = await freePort()
    const made = relay()
    await made.apply(
      configFor({ url: `http://127.0.0.1:${up.port}/dav`, relayEnabled: true, relayPort: port, relayUser: 'dsh1', relayPassword: 'p' }),
    )
    const answer = await ask(port, '/dav/old', { headers: { authorization: basic('dsh1', 'p') } })
    expect(answer.headers.location).toBe('https://elsewhere.example/x')
  })

  it('says so when the server behind it cannot be reached', async () => {
    const gone = await freePort()
    const port = await freePort()
    const made = relay()
    await made.apply(
      configFor({ url: `http://127.0.0.1:${gone}/dav`, relayEnabled: true, relayPort: port, relayUser: 'dsh1', relayPassword: 'p' }),
    )
    const answer = await ask(port, '/dav/a', { headers: { authorization: basic('dsh1', 'p') } })
    expect(answer.status).toBe(502)
    expect(answer.body).toMatch(/转发到服务器失败/)
  })
})
