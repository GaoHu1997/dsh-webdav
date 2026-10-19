/**
 * The WebDAV client. One file lives at `<address>/dsh-webdav/dsh-profile.dshsync`,
 * and the whole protocol between this computer and that file is:
 *
 *   - read it, with the version last seen so an unchanged file costs one request;
 *   - write it over the version that was read, so another computer's write in
 *     between is refused rather than silently overwritten.
 *
 * The servers that answer are as varied as the people who run them: 坚果云
 * (Nutstore) counts requests per account and answers a read of a folder that is
 * not there with 409 rather than 404; Synology answers 403 for a file in a
 * missing folder; Apache's mod_deflate rewrites an ETag for the compressed copy
 * it hands back, which then never matches in `If-Match`. Every one of those is
 * handled where it happens, with the reason it exists written beside it.
 */

import { REMOTE_FILE, REMOTE_FOLDER, type ServerVersion } from './wire.js'

/** The file was not written because it changed on the server since it was read. */
export class ChangedError extends Error {
  constructor() {
    super('本机写入期间，服务器上的文件变了：请再同步一次，看看它现在是什么')
    this.name = 'ChangedError'
  }
}

/** The file is still the version last read; the server did not send it again. */
export class NotModifiedError extends Error {
  constructor() {
    super('服务器上的文件没有变化')
    this.name = 'NotModifiedError'
  }
}

/** The server refused the account. */
export class LoginError extends Error {
  constructor() {
    super('WebDAV 服务器拒绝了用户名或密码（HTTP 401）')
    this.name = 'LoginError'
  }
}

/** The server is limiting how often it is reached, or is busy. */
export class RateLimitedError extends Error {
  constructor(
    readonly status: number,
    readonly after: number,
  ) {
    super(
      status === 429
        ? 'WebDAV 服务器限制了本机的访问频率（HTTP 429）：下次同步会多等一会儿再试'
        : `WebDAV 服务器忙，或者限制了访问频率（HTTP ${status}）：下次同步会多等一会儿再试`,
    )
    this.name = 'RateLimitedError'
  }
}

/** A 403 the server would not explain; carries the folder the address names. */
export class ForbiddenError extends Error {
  constructor(message: string, readonly explained: boolean) {
    super(message)
    this.name = 'ForbiddenError'
  }
}

/** Largest file this plugin will read back from a server. */
const MAX_BYTES = 64 * 1024 * 1024

/** How long a single request may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 120_000

/** What one address and account reach. */
export interface DavOptions {
  url: string
  user: string
  password: string
}

/**
 * What one read found. `data` is absent when the server holds no file yet — which
 * servers say in several ways, none of them an error. `notModified` is set when
 * the server answered the conditional read with 304, in which case `data` is
 * absent and `version` is the one that was asked about.
 */
export interface DavRead {
  data?: Uint8Array
  version: ServerVersion
  notModified?: boolean
  /** Where a redirect ended, when it ended somewhere other than the file. */
  redirectedTo?: string
}

/** A resolved WebDAV endpoint. */
export class Dav {
  private readonly base: URL
  /**
   * The address's own path, without a trailing slash, and empty for a server
   * root. It is kept aside because a URL cannot hold that emptiness: assigning
   * `''` to a pathname puts the `/` straight back, and joining onto that `/`
   * would build `//dsh-webdav`, which servers answer 400 to.
   */
  private readonly basePath: string
  private readonly user: string
  private readonly password: string

  constructor(options: DavOptions) {
    const trimmed = (options.url ?? '').trim()
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      throw new Error(`「${trimmed}」不是 WebDAV 地址（形如 https://…）`)
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error(`「${trimmed}」不是 WebDAV 地址（形如 https://…）`)
    }
    if (parsed.host === '') throw new Error(`「${trimmed}」不是 WebDAV 地址（形如 https://…）`)
    const path = parsed.pathname.replace(/\/+$/, '')
    parsed.pathname = path
    this.base = parsed
    this.basePath = path
    this.user = options.user ?? ''
    this.password = options.password ?? ''
  }

  /** The address, without any credentials that may have ridden in on it. */
  get address(): string {
    const shown = new URL(this.base.toString())
    shown.username = ''
    shown.password = ''
    return shown.toString().replace(/\/$/, '')
  }

  /** The full URL of one path under the address. */
  url(...parts: string[]): string {
    const url = new URL(this.base.toString())
    url.pathname = `${this.basePath}/${parts.join('/')}`
    return url.toString()
  }

  /** Where the backup file itself lives. */
  get fileUrl(): string {
    return this.url(REMOTE_FOLDER, REMOTE_FILE)
  }

  /**
   * Read the backup.
   *
   * Returns `undefined` when the server holds none yet — which several servers
   * say in several ways. Throws {@link NotModifiedError} when `have` is still
   * current, {@link LoginError}, {@link RateLimitedError} or {@link ForbiddenError}.
   */
  async get(have?: ServerVersion): Promise<DavRead> {
    const headers: Record<string, string> = { 'accept-encoding': 'identity' }
    // The read asks for the file uncompressed because the ETag it returns is what
    // the write after it matches with If-Match, and a server that compresses
    // changes that ETag for the compressed copy.
    if (have?.etag !== undefined && have.etag !== '') headers['if-none-match'] = have.etag
    else if (have?.modified !== undefined && have.modified !== '') headers['if-modified-since'] = have.modified

    const conditional = headers['if-none-match'] !== undefined || headers['if-modified-since'] !== undefined
    const response = await this.send('GET', this.fileUrl, undefined, headers)

    if (response.status === 304 && conditional) {
      return { version: have ?? {}, notModified: true }
    }
    if (response.status === 403) {
      // A Synology answers 403, not 404, for a file in a folder that is not
      // there — which is the state before the first sync.
      if (!(await this.there(`${this.url(REMOTE_FOLDER)}/`))) return { version: {} }
      throw await this.forbiddenMessage()
    }
    if (response.status === 404 || response.status === 410 || response.status === 409) {
      // 409 is how 坚果云 answers a read of a folder that is not there yet.
      return { version: {} }
    }
    if (response.status !== 200) {
      await drain(response)
      throw new Error(`从 WebDAV 服务器读取 ${REMOTE_FILE} 失败：HTTP ${response.status}`)
    }
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > MAX_BYTES) {
      throw new Error(`WebDAV 服务器上的文件超过 ${MAX_BYTES} 字节，没有读取`)
    }
    const data = await unpacked(buffer, response.headers.get('content-encoding'))
    // A redirect that ended somewhere other than the file — a web app's sign-in
    // or files page — is carried out with where it went, so the caller can say
    // the address is the thing to fix rather than call the page a damaged file.
    if (response.redirected) {
      const to = new URL(response.url)
      to.search = ''
      to.hash = ''
      to.username = ''
      to.password = ''
      return { data, version: versionOf(response.headers), redirectedTo: `${to.host}${to.pathname}` }
    }
    return { data, version: versionOf(response.headers) }
  }

  /**
   * Write the backup, only over the version that was read when there was one.
   *
   * Relays and tunnels cut long writes short, and the half that lands reads back
   * as damage on every sync after, so what a write kept is read back and
   * compared; a short write is tried again.
   */
  async put(data: Uint8Array, etag?: string): Promise<ServerVersion> {
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream' }
    if (etag !== undefined && etag !== '') headers['if-match'] = etag

    for (let attempt = 0, writes = 0; ; attempt++) {
      const response = await this.send('PUT', this.fileUrl, data, headers)
      if (response.status >= 200 && response.status < 300) {
        writes++
        const serverEtag = response.headers.get('etag') ?? ''
        await drain(response)
        const kept = await this.verifyLength(this.fileUrl, data.byteLength)
        if (kept.short) {
          if (writes < 3) {
            // The half file is a new version: the retry matches it — the ETag the
            // PUT answered, else the one the check read; with neither, the old one
            // goes, for it can no longer be current.
            const next = serverEtag !== '' ? serverEtag : kept.etag
            if (next !== '') headers['if-match'] = next
            else delete headers['if-match']
            continue
          }
          throw new Error(
            `WebDAV 服务器只收下了 ${REMOTE_FILE} 的 ${kept.length}/${data.byteLength} 字节：写入被截断了——请再同步一次；如果一直如此，说明到服务器的网络在丢弃长上传`,
          )
        }
        return serverEtag === '' ? {} : { etag: serverEtag }
      }
      await drain(response)
      if (response.status === 412) throw new ChangedError()
      if (response.status === 403 && (attempt > 0 || (await this.there(`${this.url(REMOTE_FOLDER)}/`)))) {
        throw await this.forbiddenMessage()
      }
      if ((response.status === 404 || response.status === 409 || response.status === 403) && attempt === 0) {
        await this.mkcol()
        continue
      }
      if (response.status === 404 || response.status === 409) {
        throw await this.nowhereMessage(response.status)
      }
      throw new Error(`向 WebDAV 服务器写入 ${REMOTE_FILE} 失败：HTTP ${response.status}`)
    }
  }

  /** Whether the address is reachable and the account may read and write in it. */
  async check(): Promise<{ ok: true }> {
    const listing = await this.propfind(this.url(), '0')
    if (listing.status === 401) throw new LoginError()
    if (listing.status === 429 || listing.status === 503) throw this.limited(listing)
    if (listing.status === 403) throw await this.forbiddenMessage()
    if (listing.status === 404 || listing.status === 409 || listing.status === 410) {
      throw new Error(
        `WebDAV 服务器上没有目录 ${displayPath(this.base)}：请先在那边建好，或者把它从地址里去掉`,
      )
    }
    if (listing.status >= 300) {
      throw new Error(`WebDAV 服务器对 ${displayPath(this.base)} 回答了 ${listing.status}`)
    }
    // Reading the address is not writing in it, so the folder is made (or found)
    // here — that is the first thing a first sync does anyway.
    const folder = await this.propfind(`${this.url(REMOTE_FOLDER)}/`, '0')
    if (folder.status === 404 || folder.status === 409 || folder.status === 410) await this.mkcol()
    else if (folder.status === 401) throw new LoginError()
    else if (folder.status === 403) throw await this.forbiddenMessage()
    else if (folder.status >= 300) {
      // Anything else is a refusal this check cannot call success: a 400 here was
      // once reported as "the server answered" while every later sync failed.
      await drain(folder)
      throw new Error(
        `WebDAV 服务器对 ${displayPath(this.base)} 里的目录 ${REMOTE_FOLDER} 回答了 ${folder.status}：地址必须是一个可以写入文件的目录`,
      )
    }
    await drain(folder)
    return { ok: true }
  }

  /** Read back what the file holds now, for the check action's report. */
  async stat(): Promise<{ exists: boolean; size?: number }> {
    const head = await this.send('HEAD', this.fileUrl, undefined, {})
    const status = head.status
    if (status === 200) {
      const declared = Number(head.headers.get('content-length') ?? '')
      await drain(head)
      if (Number.isFinite(declared) && declared > 0) return { exists: true, size: declared }
      // A server may report a stored file's length as 0 on HEAD (坚果云 answers
      // 0 for a file it holds in full, magpie #1259), so a zero — or no length
      // at all — is asked of PROPFIND before it is believed.
      const found = await this.length(this.fileUrl)
      if (found !== undefined && found > 0) return { exists: true, size: found }
      return Number.isFinite(declared) && declared >= 0 ? { exists: true, size: declared } : { exists: true }
    }
    await drain(head)
    if (status === 401) throw new LoginError()
    if (status === 429 || status === 503) throw this.limited(head)
    // 405: the server does not do HEAD, so the size is asked of PROPFIND instead.
    // 403/404/409/410: no file yet, which is not an error here.
    const found = await this.length(this.fileUrl)
    return found === undefined ? { exists: false } : { exists: true, size: found }
  }

  /**
   * Make the folder, tolerating the several ways servers say it is already
   * there or that the folder above it is missing.
   */
  async mkcol(): Promise<void> {
    const response = await this.send('MKCOL', `${this.url(REMOTE_FOLDER)}/`, undefined, {})
    const status = response.status
    await drain(response)
    if (status === 409) {
      throw new Error(
        `WebDAV 服务器上没有目录 ${displayPath(this.base)}（HTTP 409）：请先在那边建好，或者把它从地址里去掉`,
      )
    }
    // 405: it is there already. 301/302: some servers answer the collection's
    // creation with a redirect to it.
    if (status >= 300 && status !== 405 && status !== 301 && status !== 302) {
      throw new Error(`在 WebDAV 服务器上创建目录 ${REMOTE_FOLDER} 失败：HTTP ${status}`)
    }
  }

  /**
   * Say why a 403 was: servers answer it for a folder that is not there as much
   * as for one the account may not write in, so the folder is looked at first.
   */
  private async forbiddenMessage(): Promise<ForbiddenError> {
    const dir = displayPath(this.base)
    const probe = await this.propfind(this.url(), '0')
    if (probe.status === 401) return new ForbiddenError(new LoginError().message, true)
    if (probe.status === 404 || probe.status === 409 || probe.status === 410) {
      return new ForbiddenError(
        `WebDAV 服务器上没有目录 ${dir}（HTTP 403）：请先在那边建好，或者把它从地址里去掉`,
        true,
      )
    }
    if (probe.status >= 200 && probe.status < 300) {
      return new ForbiddenError(
        `WebDAV 服务器不允许这个账号写入 ${dir}（HTTP 403）：请确认这个账号可以改动那个目录里的文件`,
        true,
      )
    }
    return new ForbiddenError(
      `WebDAV 服务器不允许这个账号使用 ${dir}（HTTP 403）：目录可能不在那里，或者这个账号没有访问它的权限`,
      false,
    )
  }

  /**
   * The folder a file could not be put in, named with the storages the address
   * does hold — OpenList's and Alist's `/dav/` is a list of their storages, where
   * MKCOL answers 405 and PUT 404, so the address has to go into one of them.
   */
  private async nowhereMessage(code: number): Promise<Error> {
    const dir = displayPath(this.base)
    const { entries, status } = await this.list(this.url())
    if (status === 404 || status === 409 || status === 410) {
      return new Error(
        `WebDAV 服务器上没有目录 ${dir}（HTTP ${code}）：请先在那边建好，或者把它从地址里去掉`,
      )
    }
    let message = `WebDAV 服务器在 ${dir} 里无处安放目录 ${REMOTE_FOLDER}（HTTP ${code}）：地址必须是一个可以写入文件的目录`
    if (entries.length > 0) {
      const child = new URL(this.base.toString())
      child.pathname = `${this.basePath}/${entries[0]}`
      message += `——在 OpenList 或 Alist 上，用它下面的某个存储（${entries.join('、')}），例如 ${child.toString()}`
    }
    return new Error(message)
  }

  /** Whether PROPFIND finds a URL: a server answering 403 for what is not there may do so here too. */
  private async there(url: string): Promise<boolean> {
    try {
      const response = await this.propfind(url, '0')
      await drain(response)
      return response.status >= 200 && response.status < 300
    } catch {
      return true
    }
  }

  /**
   * The size a write kept, read back. `short` is true only when a real size was
   * found and it is less than what was sent: a HEAD that cannot be done leaves
   * the write unchecked, because it landed either way.
   */
  private async verifyLength(url: string, want: number): Promise<{ short: boolean; length: number; etag: string }> {
    let response: Response
    try {
      response = await this.send('HEAD', url, undefined, {})
    } catch {
      return { short: false, length: want, etag: '' }
    }
    if (response.status !== 200) {
      await drain(response)
      const found = await this.length(url)
      return found === undefined
        ? { short: false, length: want, etag: '' }
        : { short: found < want, length: found, etag: '' }
    }
    const etag = response.headers.get('etag') ?? ''
    const declared = Number(response.headers.get('content-length') ?? '')
    await drain(response)
    if (!Number.isFinite(declared) || declared < 0 || declared >= want) {
      return { short: false, length: want, etag }
    }
    // A HEAD's Content-Length is not always the file's: 坚果云 answered a
    // 6869-byte file's with 0 on every try. The length WebDAV keeps is
    // PROPFIND's getcontentlength, so a short HEAD is asked of that before it is
    // believed; with no length there, the HEAD's stands.
    const found = await this.length(url)
    if (found === undefined) return { short: true, length: declared, etag }
    return { short: found < want, length: found, etag }
  }

  /** The file's size as PROPFIND (Depth 0) reports it; `undefined` when it says none. */
  private async length(url: string): Promise<number | undefined> {
    const response = await this.propfind(url, '0')
    if (response.status !== 207) {
      await drain(response)
      return undefined
    }
    const body = await response.text()
    const match = /<[^>]*getcontentlength[^>]*>\s*(\d+)\s*</i.exec(body)
    if (match === null) return undefined
    const value = Number(match[1] ?? '')
    return Number.isFinite(value) && value >= 0 ? value : undefined
  }

  /** The child collections of a URL, as PROPFIND (Depth 1) lists them, and the status. */
  private async list(url: string): Promise<{ entries: string[]; status: number }> {
    const response = await this.propfind(url, '1')
    if (response.status !== 207) {
      await drain(response)
      return { entries: [], status: response.status }
    }
    const body = await response.text()
    const self = this.basePath
    const entries: string[] = []
    for (const block of body.split(/<[^>]*response[\s>]/i).slice(1)) {
      if (!/<[^>]*collection/i.test(block)) continue
      const href = /<[^>]*href[^>]*>([\s\S]*?)</i.exec(block)
      if (href === null) continue
      let path = decodeXml(href[1] ?? '')
      try {
        path = new URL(path, url).pathname
      } catch {
        // A href that is already a path is used as it came.
      }
      path = path.replace(/\/+$/, '')
      const parent = path.slice(0, path.lastIndexOf('/'))
      if (path === self || (parent !== self && !(self === '' && parent === ''))) continue
      const name = path.slice(path.lastIndexOf('/') + 1)
      if (name !== '' && !entries.includes(name)) entries.push(name)
      if (entries.length >= 5) break
    }
    return { entries, status: response.status }
  }

  /** One PROPFIND, with the Depth header the caller asks for. */
  private async propfind(url: string, depth: '0' | '1'): Promise<Response> {
    return this.send('PROPFIND', url, undefined, { depth })
  }

  /** One request, with auth, redirect and rate-limit handling applied. */
  private async send(method: string, url: string, body?: Uint8Array, headers: Record<string, string> = {}): Promise<Response> {
    const requestHeaders = new Headers()
    for (const [key, value] of Object.entries(headers)) requestHeaders.set(key, value)
    if (this.user !== '' || this.password !== '') {
      requestHeaders.set('authorization', `Basic ${Buffer.from(`${this.user}:${this.password}`, 'utf8').toString('base64')}`)
    }
    let response: Response
    try {
      const init: RequestInit = {
        method,
        headers: requestHeaders,
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
      // Assigned rather than set in the literal: with exactOptionalPropertyTypes a
      // `body: undefined` is not the same as no body at all.
      if (body !== undefined) init.body = new Blob([new Uint8Array(body)])
      response = await fetch(url, init)
    } catch (cause) {
      throw new Error(`连接 WebDAV 服务器 ${this.address} 失败：${describeCause(cause)}`)
    }
    if (response.status === 401) {
      await drain(response)
      throw new LoginError()
    }
    if (response.status === 429 || response.status === 503) throw this.limited(response)
    return response
  }

  /** The rate-limit error for an answer, carrying the server's own wait when it named one. */
  private limited(response: Response): RateLimitedError {
    return new RateLimitedError(response.status, retryAfter(response.headers.get('retry-after')))
  }
}

/** The version an answer's headers name; empty when nothing can be asked about again. */
function versionOf(headers: Headers): ServerVersion {
  const etag = headers.get('etag')
  if (etag !== null && etag !== '') return { etag }
  const modified = headers.get('last-modified')
  if (modified === null || modified === '') return {}
  const stamp = Date.parse(modified)
  const served = Date.parse(headers.get('date') ?? '')
  if (!Number.isFinite(stamp)) return {}
  // Kept only when it was a second or more before the server's own clock at the
  // read, so a write later in that same second cannot go unseen.
  if (!Number.isFinite(served) || served - stamp < 1000) return {}
  return { modified }
}

/** A Retry-After header's wait in milliseconds: seconds, a date, or 0. */
function retryAfter(value: string | null): number {
  if (value === null) return 0
  const trimmed = value.trim()
  const seconds = Number(trimmed)
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000)
  const at = Date.parse(trimmed)
  if (Number.isFinite(at)) return Math.max(at - Date.now(), 0)
  return 0
}

/**
 * Go's HTTP client unpacks a gzip body only when it asked for gzip itself; the
 * same note applies here, where a server that compresses an `identity` read has
 * to be unpacked by hand.
 */
async function unpacked(data: Uint8Array, encoding: string | null): Promise<Uint8Array> {
  const word = (encoding ?? '').trim().toLowerCase()
  if (word === '' || word === 'identity') return data
  if (word !== 'gzip' && word !== 'x-gzip' && word !== 'deflate') {
    throw new Error(`WebDAV 服务器用了本插件不认的编码发送文件（${word}）`)
  }
  const { gunzipSync, inflateSync } = await import('node:zlib')
  const buffer = Buffer.from(data)
  const plain = word === 'deflate' ? inflateSync(buffer) : gunzipSync(buffer)
  return new Uint8Array(plain)
}

/** Read and discard a body, so the connection can be reused. */
async function drain(response: Response): Promise<void> {
  try {
    await response.arrayBuffer()
  } catch {
    // A body that cannot be read is of no use to anybody.
  }
}

/** The path an address names, for messages. */
function displayPath(url: URL): string {
  return url.pathname === '' || url.pathname === '/' ? '/' : url.pathname
}

/** A fetch rejection's cause, said in one line. */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const nested = (cause as { cause?: unknown }).cause
    if (nested instanceof Error && nested.message !== '') return `${cause.message} (${nested.message})`
    return cause.message
  }
  return String(cause)
}

/** The five XML entities a href may carry. */
function decodeXml(value: string): string {
  return value
    .trim()
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
