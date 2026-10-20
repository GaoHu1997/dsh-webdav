/**
 * The forwarder for other WebDAV clients on this computer.
 *
 * It is a switch on the sync's own configuration, not a second one. There is
 * nothing here to fill in: the address it forwards to, the account it signs in
 * with and the extra headers it adds are the ones the sync is already configured
 * with, and it reads them per request from the configuration the host is holding.
 * What it adds is a door a local client can come in by — an address on loopback,
 * and an account of its own to knock with, because those clients hold that
 * account and must not be handed the real WebDAV password as well.
 *
 * What it does is a byte pipe. It does not parse WebDAV, does not merge anything,
 * and never changes the path a client asked for beyond putting the target's own
 * base path in front of it when the client did not keep it. The only other thing
 * it touches is the `location` header of a redirect, which is pointed back here.
 */

import { randomBytes } from 'node:crypto'
import {
  createServer,
  request as httpRequest,
  validateHeaderName,
  validateHeaderValue,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { sameSecret } from './crypto.js'
import { parseHeaders } from './dav.js'
import { defaultConfig } from './state.js'
import {
  RELAY_PASSWORD_BYTES,
  RELAY_USER_BYTES,
  relayBasePath,
  relayUrl,
  type RelayView,
  type SyncConfig,
} from './wire.js'

/** How long one forwarded request may take before the pipe is cut. */
const FORWARD_TIMEOUT_MS = 120_000

/**
 * Headers that belong to one connection rather than to the message, so they must
 * not be forwarded in either direction (RFC 7230 §6.1). `host` is dropped too:
 * the target's own host is what the forwarded request must carry.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function connectionHeaders(headers: Record<string, string | string[] | undefined>): Set<string> {
  const skipped = new Set(HOP_BY_HOP)
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'connection' || value === undefined) continue
    for (const token of (Array.isArray(value) ? value.join(',') : value).split(',')) {
      skipped.add(token.trim().toLowerCase())
    }
  }
  return skipped
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** The name half of a fresh account: short, hex, and easy to type again. */
export function makeRelayUser(): string {
  return `dsh${randomBytes(RELAY_USER_BYTES).toString('hex')}`
}

/** The password half of a fresh account. Minted once and then kept. */
export function makeRelayPassword(): string {
  return randomBytes(RELAY_PASSWORD_BYTES).toString('hex')
}

/** The Basic credential a client signs in with, as it comes off the wire. */
function basicOf(header: string | undefined): { user: string; password: string } | undefined {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return undefined
  let decoded: string
  try {
    decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8')
  } catch {
    return undefined
  }
  const mark = decoded.indexOf(':')
  if (mark < 0) return undefined
  return { user: decoded.slice(0, mark), password: decoded.slice(mark + 1) }
}

/** The Basic credential to send on, for an account that has either half. */
function basicFor(config: SyncConfig): string {
  return `Basic ${Buffer.from(`${config.user}:${config.password}`, 'utf8').toString('base64')}`
}

/** The address a client is given for one configuration. */
function addressOf(config: SyncConfig): string {
  if (!config.relayEnabled) return ''
  return relayUrl(config.relayPort, relayBasePath(config.url))
}

/**
 * The forwarder itself.
 *
 * One instance lives for as long as the host runs. The host hands it the
 * configuration it is holding — at startup, after every save, and on every card
 * read — and it brings its listening socket in line with it. The configuration
 * is kept rather than looked up per request, so a request never waits on a file
 * read, and the account, the target and the headers it uses are all from one
 * single version of the configuration.
 */
export class RelayServer {
  private config: SyncConfig = defaultConfig()
  private server: Server | undefined
  private failure = ''
  /** The port the socket in hand is bound to, so a change of port rebuilds it. */
  private bound = -1
  /** Socket changes cannot overlap a startup read, a save, or a status poll. */
  private pending: Promise<void> = Promise.resolve()

  private enqueue(change: () => Promise<void>): Promise<void> {
    const next = this.pending.then(change)
    this.pending = next.catch(() => undefined)
    return next
  }

  /**
   * Bring the socket in line with a configuration.
   *
   * Off, or on with something missing, closes it rather than leaving a listener
   * that answers every request with a complaint: a client that reaches a door
   * gets a straight answer from the server behind it, or no door at all. A port
   * that is merely taken is not a refusal — the configuration is good, the socket
   * is not, and {@link view} says which.
   */
  apply(config: SyncConfig): Promise<void> {
    const snapshot = { ...config, dirs: [...config.dirs] }
    return this.enqueue(() => this.applyNow(snapshot))
  }

  private async applyNow(config: SyncConfig): Promise<void> {
    this.config = config
    this.failure = ''
    if (!config.relayEnabled) {
      await this.close()
      return
    }
    try {
      this.targetOf(config)
      this.accountOf(config)
      const headers = this.configuredHeaders(config)
      for (const [name, value] of Object.entries(headers)) {
        validateHeaderName(name)
        validateHeaderValue(name, value)
      }
    } catch (cause) {
      this.failure = message(cause)
      await this.close()
      return
    }
    if (this.server !== undefined && this.bound === config.relayPort) return
    await this.close()
    await this.listen(config.relayPort)
  }

  /** What the card shows. Never throws: a failure is a field, not an exception. */
  view(): RelayView {
    const config = this.config
    return {
      enabled: config.relayEnabled,
      port: config.relayPort,
      url: addressOf(config),
      user: config.relayUser,
      password: config.relayPassword,
      listening: this.server !== undefined,
      error: this.failure,
    }
  }

  /** Stop listening. Called when the plugin is disposed. */
  stop(): Promise<void> {
    return this.enqueue(async () => {
      await this.close()
      this.failure = ''
    })
  }

  /** The target address, parsed, or the complaint the card shows. */
  private targetOf(config: SyncConfig): URL {
    const text = config.url.trim()
    if (text === '') throw new Error('转发要有 WebDAV 地址可去：先把上面的地址填上')
    let url: URL
    try {
      url = new URL(text)
    } catch {
      throw new Error(`WebDAV 地址不是地址：「${text}」`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`WebDAV 地址要用 http 或 https：「${text}」`)
    }
    return url
  }

  /** The account a client has to sign in with, or the complaint the card shows. */
  private accountOf(config: SyncConfig): void {
    if (config.relayUser === '' || config.relayPassword === '') {
      throw new Error('转发的账号还没生成：保存一次就会生成')
    }
  }

  /** Rebuild the socket for one port. Failures are recorded, never thrown. */
  private async listen(port: number): Promise<void> {
    const server = createServer((req, res) => this.handle(req, res))
    try {
      await new Promise<void>((settle, fail) => {
        server.once('error', fail)
        // Loopback only, and deliberately: this door is for programs on this
        // computer, and the account is what stands behind it either way.
        server.listen(port, '127.0.0.1', () => {
          server.off('error', fail)
          settle()
        })
      })
    } catch (cause) {
      this.failure = `转发端口 ${port} 用不了：${message(cause)}`
      server.close()
      return
    }
    // After it is up, an error must not take the host process down with it.
    server.on('error', (cause) => {
      this.failure = message(cause)
    })
    this.server = server
    this.bound = port
  }

  /** Close the socket and anything still talking on it. */
  private async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.bound = -1
    if (server === undefined) return
    await new Promise<void>((settle) => {
      server.close(() => settle())
      // A client holding a keep-alive connection would otherwise keep the port
      // bound past the moment the card says it was let go.
      server.closeAllConnections()
    })
  }

  /**
   * One forwarded request.
   *
   * The caller signs in with the relay's account, and only then is anything sent
   * on: an address on loopback is not a boundary — any program on this computer
   * can reach it — so the account is the whole of what decides who may spend the
   * sync's credentials, and a caller that does not have it learns nothing.
   */
  private handle(req: IncomingMessage, res: ServerResponse): void {
    const config = this.config
    if (!this.authorised(req, config)) {
      this.refuse(res, 401, '这个转发地址要用你自己的账号密码', {
        'www-authenticate': 'Basic realm="dsh-webdav-sync", charset="UTF-8"',
      })
      return
    }
    let target: URL
    try {
      target = this.targetOf(config)
    } catch (cause) {
      this.refuse(res, 502, message(cause))
      return
    }

    const raw = req.url ?? '/'
    const cut = raw.indexOf('?')
    const pathname = cut < 0 ? raw : raw.slice(0, cut)
    const search = cut < 0 ? '' : raw.slice(cut)
    const path = `${this.upstreamPath(target, pathname)}${search === '' ? target.search : search}`

    const options: RequestOptions = {
      method: req.method ?? 'GET',
      hostname: target.hostname,
      port: target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port),
      path,
      headers: this.forwardHeaders(req, config),
    }

    let answered = false
    const ask = target.protocol === 'https:' ? httpsRequest : httpRequest
    const upstream = ask(options, (answer) => {
      answered = true
      res.writeHead(answer.statusCode ?? 502, this.responseHeaders(answer, config, target))
      answer.pipe(res)
    })
    upstream.setTimeout(FORWARD_TIMEOUT_MS, () => {
      upstream.destroy(new Error(`转发到 ${config.url} 超时`))
    })
    upstream.on('error', (cause) => {
      if (answered) {
        // The answer had already started; all that is left is to cut it off.
        res.destroy()
        return
      }
      this.refuse(res, 502, `转发到服务器失败：${message(cause)}`)
    })
    req.pipe(upstream)
  }

  /** Whether a caller signed in with the relay's own account. */
  private authorised(req: IncomingMessage, config: SyncConfig): boolean {
    if (config.relayUser === '' || config.relayPassword === '') return false
    const given = basicOf(req.headers.authorization)
    if (given === undefined) return false
    // Both halves are compared even once one has failed, so the answer takes the
    // same time whichever half a caller got wrong.
    const user = sameSecret(given.user, config.relayUser)
    const password = sameSecret(given.password, config.relayPassword)
    return user && password
  }

  /**
   * Where a request the client made goes on the real server.
   *
   * The address the client was given carries the target's own base path, and
   * clients differ in what they do with it: one joins its paths onto the host
   * alone, another keeps the base path it was handed and appends to it. Both are
   * made to work — a path that already begins with the base path is taken as it
   * stands, and one that does not is given it — so the same address is correct
   * for either habit rather than only for the one the author happened to test.
   */
  private upstreamPath(target: URL, pathname: string): string {
    // A client that pasted the address with a trailing slash and joined its own
    // path onto it arrives with two slashes at the seam. One is the artifact;
    // everything else is passed on exactly as asked.
    const asked = pathname.startsWith('//') ? pathname.slice(1) : pathname
    const base = target.pathname.replace(/\/+$/, '')
    if (base === '') return asked === '' ? '/' : asked
    if (asked === base || asked.startsWith(`${base}/`)) return asked
    const rest = asked === '' ? '/' : asked.startsWith('/') ? asked : `/${asked}`
    return `${base}${rest}`
  }

  /**
   * The headers the forwarded request carries.
   *
   * The configured ones are the reason the forwarder exists, and the client's own
   * are the protocol headers its request is made of, so a collision goes to the
   * client. `authorization` is the one header that never comes from the client:
   * it was addressed to this forwarder, not to the server, and the server is given
   * the sync's own credential — or, when the configuration names an
   * `Authorization` line of its own, exactly that line, since a hand-written one
   * is the more specific instruction.
   */
  /** Configuration headers obey the same connection boundary as client headers. */
  private configuredHeaders(config: SyncConfig): Record<string, string> {
    const headers = parseHeaders(config.headers)
    const skipped = connectionHeaders(headers)
    return Object.fromEntries(Object.entries(headers).filter(([name]) => !skipped.has(name.toLowerCase()) && name.toLowerCase() !== 'host' && name.toLowerCase() !== 'expect'))
  }

  private forwardHeaders(req: IncomingMessage, config: SyncConfig): Record<string, string | string[]> {
    const taken = new Map<string, { name: string; value: string | string[] }>()
    for (const [name, value] of Object.entries(this.configuredHeaders(config))) {
      taken.set(name.toLowerCase(), { name, value })
    }
    const skipped = connectionHeaders(req.headers)
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      const lower = name.toLowerCase()
      if (skipped.has(lower) || lower === 'host' || lower === 'authorization') continue
      // A per-hop handshake: passed on, the server would hold the request waiting
      // for a continue that is not coming from the same connection.
      if (lower === 'expect') continue
      taken.set(lower, { name, value })
    }
    if (!taken.has('authorization') && (config.user !== '' || config.password !== '')) {
      taken.set('authorization', { name: 'authorization', value: basicFor(config) })
    }
    const out: Record<string, string | string[]> = {}
    for (const { name, value } of taken.values()) out[name] = value
    return out
  }

  /** The headers a response carries back: connection-level ones out, location mapped. */
  private responseHeaders(answer: IncomingMessage, config: SyncConfig, target: URL): IncomingHttpHeaders {
    const out: IncomingHttpHeaders = {}
    const skipped = connectionHeaders(answer.headers)
    for (const [name, value] of Object.entries(answer.headers)) {
      if (value === undefined) continue
      const lower = name.toLowerCase()
      if (skipped.has(lower)) continue
      if (lower === 'location') {
        out[name] = Array.isArray(value)
          ? value.map((one) => this.rewriteLocation(one, config, target))
          : this.rewriteLocation(value, config, target)
        continue
      }
      out[name] = value
    }
    return out
  }

  /**
   * A redirect that points at the real server is pointed back at this forwarder,
   * path and query untouched. Left alone, the client would follow it straight to
   * the server and from then on talk around the forwarder — losing the account
   * and the headers this exists for.
   */
  private rewriteLocation(location: string, config: SyncConfig, target: URL): string {
    const basePath = target.pathname.replace(/\/+$/, '')
    const here = relayUrl(config.relayPort, basePath)
    const origin = `${target.protocol}//${target.host}`
    const prefix = `${origin}${basePath}`
    if (location.startsWith(prefix)) {
      const rest = location.slice(prefix.length)
      if (rest === '' || rest.startsWith('/') || rest.startsWith('?') || rest.startsWith('#')) {
        return `${here}${rest}`
      }
    }
    // A path-only location is relative to the target's own origin.
    if (basePath !== '' && (location === basePath || location.startsWith(`${basePath}/`))) {
      return `${here}${location.slice(basePath.length)}`
    }
    return location
  }

  /** Answer with a short plain-text refusal, unless the answer already started. */
  private refuse(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
    })
    res.end(text)
  }
}
