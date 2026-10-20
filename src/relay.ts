/**
 * The relay: an in-process forwarder a WebDAV client on this computer can talk
 * through when that client cannot set the request headers its server wants.
 *
 * It is a feature of its own, deliberately: its configuration lives in its own
 * file, its routes live under their own prefix, and nothing here reads or writes
 * the sync's configuration or state. The sync never goes through it and it never
 * goes through the sync.
 *
 * What it does is a byte pipe. It does not parse WebDAV, does not merge anything,
 * and — the point of the whole thing — never changes the path a client asked for.
 * A client is given an address of the form `http://127.0.0.1:<port>/<token>`; the
 * one path segment that is the token is taken off, and whatever the client put
 * after it is appended to the configured target address exactly as it arrived,
 * query included. The only addition is the configured request headers.
 */

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { parseHeaders } from './dav.js'
import type { RelayPaths } from './paths.js'
import {
  RELAY_DEFAULT_PORT,
  RELAY_TOKEN_BYTES,
  relayUrl,
  type RelayBody,
  type RelayConfig,
  type RelayStatusResult,
} from './wire.js'

/** The configuration file is a secret: it names where traffic goes and what is added to it. */
const FILE_MODE = 0o600
/** Its directory is the plugin's own, like the sync's. */
const DIR_MODE = 0o700
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

/** A token: 32 hex characters, unguessable, and always safe in a path. */
const TOKEN_PATTERN = /^[0-9a-f]{32}$/

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** The resting configuration: off, on the default port, nothing to forward yet. */
export function defaultRelay(): RelayConfig {
  return { enabled: false, port: RELAY_DEFAULT_PORT, token: '', target: '', headers: '' }
}

/**
 * A fresh token. Minted once and then kept: it is part of the address a client is
 * configured with, so changing it means the client has to be pointed at the relay
 * again — see {@link RelayConfig.token}.
 */
export function makeRelayToken(): string {
  return randomBytes(RELAY_TOKEN_BYTES).toString('hex')
}

/**
 * Coerce what is on disk into a configuration.
 *
 * A field that is not the shape it must be falls back to its resting value rather
 * than being carried along: a token that is not one is worse than no token,
 * because it would be handed to a client as if it were an address.
 */
export function normaliseRelay(raw: Record<string, unknown>): RelayConfig {
  const base = defaultRelay()
  const text = (key: string, fallback: string): string =>
    typeof raw[key] === 'string' ? (raw[key] as string) : fallback
  const port = raw.port
  const usablePort =
    typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65_535 ? port : base.port
  const token = typeof raw.token === 'string' && TOKEN_PATTERN.test(raw.token) ? raw.token : ''
  return {
    enabled: raw.enabled === true,
    port: usablePort,
    token,
    target: text('target', base.target).trim(),
    headers: text('headers', base.headers),
  }
}

/** The relay's file, read the way the sync reads its own: absent is not corrupt. */
async function readJson(file: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`${file} 读不出来：${message(cause)}`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch (cause) {
    throw new Error(`${file} 不是可读的 JSON：${message(cause)}`)
  }
}

/** Read the relay configuration, saying whether there was one at all. */
export async function loadRelay(paths: RelayPaths): Promise<{ config: RelayConfig; found: boolean }> {
  const raw = await readJson(paths.file)
  if (raw === undefined) return { config: defaultRelay(), found: false }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${paths.file} 里不是 JSON 对象`)
  }
  return { config: normaliseRelay(raw as Record<string, unknown>), found: true }
}

/** Write the relay configuration: 0600 in a 0700 directory, replaced atomically. */
export async function saveRelay(paths: RelayPaths, config: RelayConfig): Promise<void> {
  await mkdir(paths.dir, { recursive: true, mode: DIR_MODE })
  const temporary = `${paths.file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: FILE_MODE })
  await rename(temporary, paths.file)
}

/**
 * The forwarder itself.
 *
 * One instance lives for as long as the host runs. It is told to {@link start}
 * once, then {@link save}d to whenever the card changes something; the listening
 * socket is rebuilt from the saved configuration each time, so the socket and the
 * file can never disagree.
 */
export class RelayServer {
  private config: RelayConfig = defaultRelay()
  private server: Server | undefined
  private failure = ''
  /** The file the configuration in hand was read from, so a moved profile is noticed. */
  private bound: string | undefined

  /**
   * `resolve` is a function rather than a value because the profile directory can
   * be changed while the host runs: the relay then follows it to the new file
   * instead of going on reading a directory the rest of the plugin has left.
   */
  constructor(private readonly resolve: () => RelayPaths) {}

  /** Read the stored configuration and listen if it asks for that. */
  async start(): Promise<void> {
    await this.bind()
  }

  /** What the card shows. Never throws: a failure is a field, not an exception. */
  async status(): Promise<RelayStatusResult> {
    await this.bind()
    return {
      config: { ...this.config },
      // No address until a token has been minted: handing out `http://127.0.0.1:3426/`
      // would be an address that forwards nothing.
      url: this.config.token === '' ? '' : relayUrl(this.config.port, this.config.token),
      listening: this.server !== undefined,
      error: this.failure,
      file: this.resolve().file,
    }
  }

  /**
   * Make the configuration in hand the one on disk, reloading when the profile
   * directory has moved under it.
   */
  private async bind(): Promise<void> {
    const paths = this.resolve()
    if (this.bound === paths.file) return
    this.bound = paths.file
    try {
      const { config } = await loadRelay(paths)
      this.config = config
    } catch (cause) {
      // A file that cannot be read is reported where the card can show it, and the
      // forwarder stays down. Saving from the card is what repairs it.
      this.config = defaultRelay()
      this.failure = message(cause)
      await this.close()
      return
    }
    await this.listen()
  }

  /**
   * Apply a change from the card, then put the socket in the shape it asks for.
   *
   * A change that cannot work — a target that is not an address, a port that is
   * not a port — is refused before anything is written, so the card can show the
   * complaint against the field the user is still looking at. A port that is
   * merely taken is not a refusal: the configuration is good, the socket is not,
   * and the status says which.
   */
  async save(body: RelayBody): Promise<RelayStatusResult> {
    await this.bind()
    const next = { ...this.config }
    if (typeof body.enabled === 'boolean') next.enabled = body.enabled
    if (typeof body.target === 'string') next.target = body.target.trim()
    if (typeof body.headers === 'string') {
      // Refused here rather than at the first forwarded request, so the card can
      // show the line it is unhappy about.
      parseHeaders(body.headers)
      next.headers = body.headers
    }
    if (typeof body.port === 'number') {
      if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65_535) {
        throw new Error(`转发端口要是 1 到 65535 之间的整数：「${body.port}」不是`)
      }
      next.port = body.port
    }
    if (typeof body.token === 'string') {
      if (body.token === '') next.token = makeRelayToken()
      else if (!TOKEN_PATTERN.test(body.token)) {
        throw new Error(`转发地址里的那段要是 32 位十六进制：「${body.token}」不是`)
      } else next.token = body.token
    }
    // First save mints the token the address is made of. Nothing is written before
    // that, so a plugin nobody uses leaves no file behind.
    if (next.token === '') next.token = makeRelayToken()
    // Switching on is refused while there is nowhere to forward to: a listener
    // that answers every request with "no target" is worse than not listening.
    if (next.enabled) this.targetOf(next)

    await saveRelay(this.resolve(), next)
    this.config = next
    await this.listen()
    return this.status()
  }

  /** Stop listening. Called when the plugin is disposed. */
  async stop(): Promise<void> {
    await this.close()
    this.failure = ''
    this.bound = undefined
  }

  /** The target address, parsed, or the complaint the card shows. */
  private targetOf(config: RelayConfig = this.config): URL {
    const text = config.target.trim()
    if (text === '') throw new Error('转发目标还没填：填上真实 WebDAV 地址，转发才有地方可去')
    let url: URL
    try {
      url = new URL(text)
    } catch {
      throw new Error(`转发目标不是地址：「${text}」`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`转发目标要用 http 或 https：「${text}」`)
    }
    return url
  }

  /** Rebuild the socket from {@link config}. Failures are recorded, never thrown. */
  private async listen(): Promise<void> {
    await this.close()
    this.failure = ''
    if (!this.config.enabled) return
    try {
      this.targetOf()
    } catch (cause) {
      this.failure = message(cause)
      return
    }
    const server = createServer((req, res) => this.handle(req, res))
    try {
      await new Promise<void>((settle, fail) => {
        server.once('error', fail)
        server.listen(this.config.port, '127.0.0.1', () => {
          server.off('error', fail)
          settle()
        })
      })
    } catch (cause) {
      this.failure = `转发端口 ${this.config.port} 用不了：${message(cause)}`
      server.close()
      return
    }
    // After it is up, an error must not take the host process down with it.
    server.on('error', (cause) => {
      this.failure = message(cause)
    })
    this.server = server
  }

  /** Close the socket and anything still talking on it. */
  private async close(): Promise<void> {
    const server = this.server
    if (server === undefined) return
    this.server = undefined
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
   * The path is taken apart exactly once — the token segment, then everything
   * else verbatim — and the response is streamed back with only the location
   * header touched, because a redirect back to the real server would send the
   * client around the relay and lose the headers it exists for.
   */
  private handle(req: IncomingMessage, res: ServerResponse): void {
    const raw = req.url ?? '/'
    const mark = raw.indexOf('?')
    const pathname = mark < 0 ? raw : raw.slice(0, mark)
    const search = mark < 0 ? '' : raw.slice(mark)

    const prefix = `/${this.config.token}`
    let rest: string
    if (pathname === prefix) rest = ''
    else if (pathname.startsWith(`${prefix}/`)) rest = pathname.slice(prefix.length)
    else {
      // Not this relay's address. 404 rather than 403: nothing about the address
      // is confirmed to a caller that does not already know it.
      this.refuse(res, 404, '没有这个地址')
      return
    }
    // A client that pasted the address with a trailing slash and then joined its
    // own path onto it arrives with two slashes at the seam. One is the artifact;
    // everything else is passed on exactly as asked.
    if (rest.startsWith('//')) rest = rest.slice(1)

    let target: URL
    try {
      target = this.targetOf()
    } catch (cause) {
      this.refuse(res, 502, message(cause))
      return
    }
    const basePath = target.pathname.replace(/\/+$/, '')
    const path = `${basePath}${rest === '' ? '/' : rest}${search}`

    const options: RequestOptions = {
      method: req.method ?? 'GET',
      hostname: target.hostname,
      port: target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port),
      path,
      headers: this.forwardHeaders(req),
    }

    let answered = false
    const ask = target.protocol === 'https:' ? httpsRequest : httpRequest
    const upstream = ask(options, (answer) => {
      answered = true
      res.writeHead(answer.statusCode ?? 502, this.responseHeaders(answer))
      answer.pipe(res)
    })
    upstream.setTimeout(FORWARD_TIMEOUT_MS, () => {
      upstream.destroy(new Error(`转发到 ${this.config.target} 超时`))
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

  /**
   * The headers the forwarded request carries.
   *
   * The configured ones are the reason the relay exists, and the client's own are
   * the protocol headers its request is made of — so a collision goes to the
   * client, except `authorization`: a configured one is the whole point of
   * "the server wants this credential", so it wins over whatever the client
   * sends, exactly as a configured `Authorization` wins over Basic auth in the
   * sync's own requests.
   */
  private forwardHeaders(req: IncomingMessage): Record<string, string | string[]> {
    const taken = new Map<string, { name: string; value: string | string[] }>()
    for (const [name, value] of Object.entries(parseHeaders(this.config.headers))) {
      taken.set(name.toLowerCase(), { name, value })
    }
    const configured = taken.get('authorization') !== undefined
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      const lower = name.toLowerCase()
      if (HOP_BY_HOP.has(lower) || lower === 'host') continue
      if (lower === 'authorization' && configured) continue
      taken.set(lower, { name, value })
    }
    const out: Record<string, string | string[]> = {}
    for (const { name, value } of taken.values()) out[name] = value
    return out
  }

  /** The headers a response carries back: connection-level ones out, location mapped. */
  private responseHeaders(answer: IncomingMessage): IncomingHttpHeaders {
    const out: IncomingHttpHeaders = {}
    for (const [name, value] of Object.entries(answer.headers)) {
      if (value === undefined) continue
      const lower = name.toLowerCase()
      if (HOP_BY_HOP.has(lower)) continue
      if (lower === 'location') {
        out[name] = Array.isArray(value) ? value.map((one) => this.rewriteLocation(one)) : this.rewriteLocation(value)
        continue
      }
      out[name] = value
    }
    return out
  }

  /**
   * A redirect that points at the real server is pointed back at the relay, path
   * and query untouched. Left alone, the client would follow it straight to the
   * server and from then on talk around the relay — losing the headers, and
   * leaving the sync reading a different server than the one it was configured
   * with.
   */
  private rewriteLocation(location: string): string {
    let target: URL
    try {
      target = this.targetOf()
    } catch {
      return location
    }
    const basePath = target.pathname.replace(/\/+$/, '')
    const relayBase = relayUrl(this.config.port, this.config.token)
    const origin = `${target.protocol}//${target.host}`
    const prefix = `${origin}${basePath}`
    if (location.startsWith(prefix)) {
      const rest = location.slice(prefix.length)
      if (rest === '' || rest.startsWith('/') || rest.startsWith('?') || rest.startsWith('#')) {
        return `${relayBase}${rest}`
      }
    }
    // A path-only location is relative to the target's own origin.
    if (location === basePath || location.startsWith(`${basePath}/`)) {
      return `${relayBase}${location.slice(basePath.length)}`
    }
    return location
  }

  /** Answer with a short plain-text refusal, unless the answer already started. */
  private refuse(res: ServerResponse, status: number, text: string): void {
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text)
  }
}
