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
 * What it does is a byte pipe for request bodies. It preserves client paths except
 * for the `.prop` compatibility suffix, and reverses only suffixes the relay added
 * when returning PROPFIND hrefs. The `location` header of a redirect is pointed
 * back here too.
 */

import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { Transform } from 'node:stream'
import { writeAtomic } from './store.js'
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

/** Give extensionless file resources a stable name accepted by backup clients. */
function withBackupExtension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  let decodedName = name
  try {
    decodedName = decodeURIComponent(name)
  } catch {
    // Preserve malformed escapes for the upstream server to handle.
  }
  if (name === '' || /\.(?:zip|prop)$/i.test(decodedName)) return path
  return `${path}.prop`
}

function aliasKey(origin: string, path: string): string {
  return `${origin}${path}`
}

function decodeXml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity) => {
    if (entity === '&amp;') return '&'
    if (entity === '&lt;') return '<'
    if (entity === '&gt;') return '>'
    if (entity === '&quot;') return '"'
    if (entity === '&apos;') return "'"
    const hex = entity.match(/^&#x([\da-f]+);$/i)
    const decimal = entity.match(/^&#(\d+);$/)
    const codepoint = hex ? Number.parseInt(hex[1]!, 16) : decimal ? Number.parseInt(decimal[1]!, 10) : NaN
    return Number.isFinite(codepoint) ? String.fromCodePoint(codepoint) : entity
  })
}

function encodeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function rewriteHref(value: string, target: URL, base: URL, aliases: Map<string, string>): string {
  const lead = value.match(/^\s*/)?.[0] ?? ''
  const tail = value.match(/\s*$/)?.[0] ?? ''
  const href = decodeXml(value.slice(lead.length, value.length - tail.length))
  const absolute = /^[a-z][a-z\d+.-]*:/i.test(href)
  const absolutePath = href.startsWith('/')
  let parsed: URL
  try {
    parsed = new URL(href, base)
  } catch {
    return value
  }
  if (parsed.origin !== target.origin) return value
  const originalPath = aliases.get(aliasKey(parsed.origin, parsed.pathname))
  if (originalPath === undefined) return value
  const baseDirectory = base.pathname.endsWith('/') ? base.pathname : base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1)
  const replacementPath = absolute || absolutePath ? originalPath : posix.relative(baseDirectory, originalPath)
  const replacement = `${absolute ? parsed.origin : ''}${replacementPath}${parsed.search}${parsed.hash}`
  return `${lead}${encodeXml(replacement)}${tail}`
}

function propfindHrefTransform(target: URL, requestPath: string, aliases: Map<string, string>): Transform {
  const decoder = new StringDecoder('utf8')
  const base = new URL(requestPath, target)
  let pending = ''
  const openHref = /<(?:[\w.-]+:)?href\b[^>]*>/i
  const closeHref = /<\/(?:[\w.-]+:)?href\s*>/i
  const flushPending = (stream: Transform, final: boolean): void => {
    for (;;) {
      const start = pending.search(openHref)
      if (start < 0) {
        if (final) {
          stream.push(pending)
          pending = ''
          return
        }
        const possibleTag = pending.lastIndexOf('<')
        const safeEnd = possibleTag < 0 ? pending.length : possibleTag
        if (safeEnd > 0) stream.push(pending.slice(0, safeEnd))
        pending = pending.slice(safeEnd)
        return
      }
      if (start > 0) {
        stream.push(pending.slice(0, start))
        pending = pending.slice(start)
      }
      const end = pending.indexOf('>')
      if (end < 0) {
        // A tag that never closes: nothing can be rewritten, and holding it back
        // would drop it from a body that is finished.
        if (final) {
          stream.push(pending)
          pending = ''
        }
        return
      }
      const open = pending.slice(0, end + 1)
      if (open.endsWith('/>')) {
        // An empty element has no text and no closing tag. Reading it as an
        // unfinished one would search the rest of the body for `</href>`, take
        // everything up to the next one — or, at the end, drop it.
        stream.push(open)
        pending = pending.slice(end + 1)
        continue
      }
      const close = closeHref.exec(pending.slice(end + 1))
      if (close === null) {
        if (final) {
          stream.push(pending)
          pending = ''
        }
        return
      }
      const closeStart = end + 1 + close.index
      const closeEnd = closeStart + close[0].length
      stream.push(open)
      stream.push(rewriteHref(pending.slice(end + 1, closeStart), target, base, aliases))
      stream.push(pending.slice(closeStart, closeEnd))
      pending = pending.slice(closeEnd)
    }
  }
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pending += decoder.write(chunk)
      flushPending(this, false)
      callback()
    },
    flush(callback) {
      pending += decoder.end()
      flushPending(this, true)
      callback()
    },
  })
}

/** The name half of a fresh account: short, hex, and easy to type again. */
export function makeRelayUser(): string {
  return `dsh${randomBytes(RELAY_USER_BYTES).toString('hex')}`
}

/** The password half of a fresh account. Minted once and then kept. */
export function makeRelayPassword(): string {
  return randomBytes(RELAY_PASSWORD_BYTES).toString('hex')
}

/**
 * The Basic credential a client signs in with, as it comes off the wire.
 *
 * RFC 7617 makes the scheme name case-insensitive, and a client is free to write
 * `basic`; refusing that would turn a correct credential into a 401 with no way
 * to see why.
 */
function basicOf(header: string | undefined): { user: string; password: string } | undefined {
  if (typeof header !== 'string') return undefined
  const space = header.indexOf(' ')
  if (space < 0 || header.slice(0, space).toLowerCase() !== 'basic') return undefined
  // `Buffer.from(…, 'base64')` never throws: it drops what is not base64. A
  // malformed value therefore arrives here as a short string and fails the
  // colon test below, which is the refusal it deserves.
  const decoded = Buffer.from(header.slice(space + 1), 'base64').toString('utf8')
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
  private aliasFile = ''
  private aliases = new Map<string, string>()
  /**
   * Paths this forwarder made as collections, and their descendants follow from
   * them. Kept beside the aliases and for the same reason: after a restart the
   * forwarder must still know which extensionless names are folders, or it would
   * send a later DELETE to a `.prop` that was never there.
   */
  private collections = new Set<string>()
  private aliasWrites: Promise<void> = Promise.resolve()
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
  apply(config: SyncConfig, stateDir?: string): Promise<void> {
    const snapshot = { ...config, dirs: [...config.dirs] }
    return this.enqueue(() => this.applyNow(snapshot, stateDir))
  }

  private async applyNow(config: SyncConfig, stateDir?: string): Promise<void> {
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
      await this.loadAliases(stateDir)
    } catch (cause) {
      this.failure = message(cause)
      await this.close()
      return
    }
    if (this.server !== undefined && this.bound === config.relayPort) return
    await this.close()
    await this.listen(config.relayPort)
  }

  private async loadAliases(stateDir?: string): Promise<void> {
    if (stateDir === undefined) return
    const file = join(stateDir, 'relay-paths.json')
    if (file === this.aliasFile) return
    // Both maps come from this one file, so both are dropped together: a folder
    // remembered under the state directory this forwarder just left is not a
    // folder here, and keeping it would send a DELETE for a name this profile
    // never created.
    this.aliases.clear()
    this.collections.clear()
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        this.aliasFile = file
        return
      }
      throw cause
    }
    const saved: unknown = JSON.parse(text)
    if (typeof saved !== 'object' || saved === null || !('version' in saved) || saved.version !== 1 || !('aliases' in saved)) {
      throw new Error('转发文件名映射记录格式不正确')
    }
    const aliases = saved.aliases
    if (typeof aliases !== 'object' || aliases === null || Array.isArray(aliases)) {
      throw new Error('转发文件名映射记录格式不正确')
    }
    for (const [key, value] of Object.entries(aliases)) {
      if (typeof value === 'string' && key.startsWith('http')) this.aliases.set(key, value)
    }
    // Absent in a file written before collections were tracked, which simply
    // means none are known yet.
    const collections = 'collections' in saved ? saved.collections : []
    if (collections !== undefined && !Array.isArray(collections)) {
      throw new Error('转发文件名映射记录格式不正确')
    }
    for (const one of collections ?? []) {
      if (typeof one === 'string' && one !== '') this.collections.add(one)
    }
    this.aliasFile = file
  }

  private saveAliases(): Promise<void> {
    if (this.aliasFile === '') return Promise.resolve()
    const snapshot = JSON.stringify({
      version: 1,
      aliases: Object.fromEntries(this.aliases),
      collections: [...this.collections].sort(),
    }, null, 2)
    const file = this.aliasFile
    const next = this.aliasWrites.catch(() => undefined).then(() => writeAtomic(file, snapshot, 0o600))
    this.aliasWrites = next
    return next
  }

  /**
   * Whether this path, or a folder above it, was made here as a collection.
   *
   * The path arrives as the client wrote it, percent-encoding and all, which is
   * exactly how it was recorded: both sides come from the same request path.
   */
  private knownCollection(path: string): boolean {
    if (this.collections.size === 0) return false
    const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
    if (this.collections.has(trimmed)) return true
    for (let cut = trimmed.lastIndexOf('/'); cut > 0; cut = trimmed.lastIndexOf('/', cut - 1)) {
      if (this.collections.has(trimmed.slice(0, cut))) return true
    }
    return false
  }

  /** Remember, or forget, that a path names a collection. */
  private async changeCollection(path: string, present: boolean): Promise<void> {
    const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
    if (trimmed === '' || this.collections.has(trimmed) === present) return
    // Everything recorded below it goes with the folder that holds it, so the
    // ones dropped are kept here: a write that fails has to put the map back the
    // way the file still has it.
    const dropped: string[] = []
    if (present) this.collections.add(trimmed)
    else {
      this.collections.delete(trimmed)
      for (const one of [...this.collections]) {
        if (one.startsWith(`${trimmed}/`)) {
          this.collections.delete(one)
          dropped.push(one)
        }
      }
    }
    try {
      await this.saveAliases()
    } catch (cause) {
      // The map is what the next request reads, so a write that failed leaves it
      // where the file is — otherwise this process answers with folders the next
      // start cannot reproduce.
      if (present) this.collections.delete(trimmed)
      else this.collections.add(trimmed)
      for (const one of dropped) this.collections.add(one)
      throw cause
    }
  }

  private async changeAlias(key: string, value: string | undefined): Promise<void> {
    const before = this.aliases.get(key)
    if (before === value) return
    if (value === undefined) this.aliases.delete(key)
    else this.aliases.set(key, value)
    try {
      await this.saveAliases()
    } catch (cause) {
      // The map is what the next request reads, so a write that failed has to
      // leave it where the file is: otherwise this process answers with names
      // the next start cannot reproduce.
      if (before === undefined) this.aliases.delete(key)
      else this.aliases.set(key, before)
      throw cause
    }
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
      await this.aliasWrites.catch(() => undefined)
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
    const upstreamPath = this.upstreamPath(target, pathname)
    const basePath = target.pathname.replace(/\/+$/, '')
    const pathOnServer = req.method === 'PROPFIND' && upstreamPath === basePath
      ? `${basePath}/`
      : upstreamPath
    const depth = req.headers.depth
    const basename = pathOnServer.slice(pathOnServer.lastIndexOf('/') + 1)
    const looksLikeFile = /\.[^./]+$/.test(basename) || [...this.aliases.values()].includes(pathOnServer)
    // PROPFIND without Depth means infinity. Depth 0 is ambiguous, so preserve
    // extensionless unknown paths rather than silently renaming a collection.
    const collectionProbe = req.method === 'PROPFIND' && (
      depth === undefined || depth !== '0' || pathOnServer.endsWith('/') || !looksLikeFile
    )
    // A collection has no file name to give, and 0046 promises that the same
    // client path keeps meaning the same file, so an extensionless path cannot
    // be judged from its spelling alone. What settles it is what this forwarder
    // saw: a path it made with MKCOL — or anything below one — is a collection
    // for every method, not just for the ones that ask.
    const pathIsCollection = req.method === 'MKCOL' || req.method === 'OPTIONS' || this.knownCollection(pathOnServer)
    const fileResource = !collectionProbe && !pathIsCollection
    const resourcePath = fileResource ? withBackupExtension(pathOnServer) : pathOnServer
    const path = `${resourcePath}${search === '' ? target.search : search}`

    const forwardedHeaders = this.forwardHeaders(req, config)
    // A moved or copied file keeps being a file under its new name, so the
    // destination follows the source rather than its own spelling.
    const destination = this.rewriteDestination(req.headers.destination, config, target, fileResource)
    if (destination !== undefined) forwardedHeaders.destination = destination.header
    if (req.method === 'PROPFIND') forwardedHeaders['accept-encoding'] = 'identity'
    const options: RequestOptions = {
      method: req.method ?? 'GET',
      hostname: target.hostname,
      port: target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port),
      path,
      headers: forwardedHeaders,
    }

    const remoteKey = aliasKey(target.origin, resourcePath)
    let answered = false
    const ask = target.protocol === 'https:' ? httpsRequest : httpRequest
    const upstream = ask(options, (answer) => {
      answered = true
      // A target that dies mid-answer leaves the pipes with nobody to end them:
      // the client would hang on a half response until its own timeout, which a
      // client without one never reaches. The connection going away is the whole
      // answer there is, so it is passed on by cutting the client loose too.
      answer.on('error', () => {
        if (!res.headersSent) this.refuse(res, 502, '转发到服务器的连接中断了')
        else res.destroy()
      })
      answer.on('aborted', () => {
        if (!res.headersSent) this.refuse(res, 502, '转发到服务器的连接中断了')
        else res.destroy()
      })
      void (async () => {
        const status = answer.statusCode ?? 502
        try {
          if (status >= 200 && status < 300) {
            // Read before the bookkeeping below changes it: whether this request
            // was addressed to a folder decides what the answer has to record.
            const wasCollection = this.knownCollection(pathOnServer)
            if (req.method === 'MKCOL') {
              await this.changeCollection(pathOnServer, true)
            } else if (req.method === 'MOVE') {
              await this.changeAlias(remoteKey, undefined)
              if (destination !== undefined) {
                const destinationKey = aliasKey(target.origin, destination.remotePath)
                await this.changeAlias(
                  destinationKey,
                  destination.remotePath === destination.clientPath ? undefined : destination.clientPath,
                )
                if (wasCollection) {
                  await this.changeCollection(pathOnServer, false)
                  await this.changeCollection(destination.clientPath, true)
                }
              } else if (wasCollection) {
                await this.changeCollection(pathOnServer, false)
              }
            } else if (req.method === 'COPY') {
              if (resourcePath !== pathOnServer) await this.changeAlias(remoteKey, pathOnServer)
              if (destination !== undefined) {
                const destinationKey = aliasKey(target.origin, destination.remotePath)
                await this.changeAlias(
                  destinationKey,
                  destination.remotePath === destination.clientPath ? undefined : destination.clientPath,
                )
                // The copy is a folder too, and will be moved and deleted on its
                // own after this; the original stays where it is.
                if (wasCollection) await this.changeCollection(destination.clientPath, true)
              }
            } else if ((req.method === 'DELETE' || (req.method === 'PUT' && resourcePath === pathOnServer)) && this.aliases.has(remoteKey)) {
              await this.changeAlias(remoteKey, undefined)
            } else if (req.method !== 'DELETE' && resourcePath !== pathOnServer) {
              await this.changeAlias(remoteKey, pathOnServer)
            }
            if (req.method === 'DELETE' && wasCollection) await this.changeCollection(pathOnServer, false)
          }
          // `identity` is not an encoding, so a server that spells it out still
          // sends the bytes this can read; only a real compression codec makes
          // the body opaque here.
          const encoding = answer.headers['content-encoding']
          const compressed = encoding !== undefined && String(encoding).trim().toLowerCase() !== 'identity'
          const rewritePropfind = req.method === 'PROPFIND' && status === 207 && !compressed
          res.writeHead(status, this.responseHeaders(answer, config, target, rewritePropfind))
          if (rewritePropfind) {
            answer.pipe(propfindHrefTransform(target, path, this.aliases)).pipe(res)
          } else {
            answer.pipe(res)
          }
        } catch (cause) {
          answer.resume()
          this.refuse(res, 502, `无法保存转发文件名映射：${message(cause)}`)
        }
      })()
    })
    upstream.setTimeout(FORWARD_TIMEOUT_MS, () => {
      upstream.destroy(new Error(`转发到 ${config.url} 超时`))
    })
    // A client that hangs up has stopped caring about the answer, and an upload
    // it abandoned would otherwise stay open until the forward timeout, holding
    // a socket on the server for two minutes after nobody wanted it.
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy()
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

  /** Map a same-relay Destination to the configured upstream and return its alias. */
  private rewriteDestination(
    header: string | string[] | undefined,
    config: SyncConfig,
    target: URL,
    fileResource = true,
  ): { header: string; clientPath: string; remotePath: string } | undefined {
    if (typeof header !== 'string') return undefined
    const local = new URL(relayUrl(config.relayPort, relayBasePath(config.url)))
    let destination: URL
    try {
      destination = new URL(header, local)
    } catch {
      return undefined
    }
    if (destination.origin !== local.origin) return undefined
    const clientPath = this.upstreamPath(target, destination.pathname)
    const remotePath = !fileResource || destination.pathname.endsWith('/')
      ? clientPath
      : withBackupExtension(clientPath)
    return {
      header: `${target.origin}${remotePath}${destination.search}${destination.hash}`,
      clientPath,
      remotePath,
    }
  }

  /** Configuration headers obey the same connection boundary as client headers. */
  private configuredHeaders(config: SyncConfig): Record<string, string> {
    const headers = parseHeaders(config.headers)
    const skipped = connectionHeaders(headers)
    return Object.fromEntries(Object.entries(headers).filter(([name]) => !skipped.has(name.toLowerCase()) && name.toLowerCase() !== 'host' && name.toLowerCase() !== 'expect'))
  }

  /**
   * The headers the forwarded request carries.
   *
   * The configured ones are the reason the forwarder exists, and the client's own
   * are the protocol headers its request is made of, so a collision goes to the
   * client — except an explicitly configured `user-agent`, which must identify
   * every forwarded client as the upstream expects. With no configured value,
   * the client's user agent passes through. `authorization` never comes from the
   * client: it was addressed to this forwarder, not to the server, which is given
   * the sync's own credential — or, when the configuration names an
   * `Authorization` line of its own, exactly that line, since a hand-written one
   * is the more specific instruction.
   */
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
      if (lower === 'user-agent' && taken.has(lower)) continue
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
  private responseHeaders(answer: IncomingMessage, config: SyncConfig, target: URL, rewriteBody = false): IncomingHttpHeaders {
    const out: IncomingHttpHeaders = {}
    const skipped = connectionHeaders(answer.headers)
    for (const [name, value] of Object.entries(answer.headers)) {
      if (value === undefined) continue
      const lower = name.toLowerCase()
      if (skipped.has(lower)) continue
      if (rewriteBody && ['content-length', 'etag', 'content-md5', 'digest'].includes(lower)) continue
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
