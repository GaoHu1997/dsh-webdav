/**
 * An in-memory WebDAV server, for the tests.
 *
 * It answers the five methods the plugin uses — GET, PUT, HEAD, PROPFIND, MKCOL —
 * and it can be told to behave like the servers the plugin was written against:
 * one that answers 409 for a read in a missing folder (坚果云), one that answers
 * 403 instead (Synology), one with no ETags at all, one that keeps only part of a
 * write. `globalThis.fetch` is swapped, so the code under test runs unchanged.
 */

import { createHash } from 'node:crypto'

export interface StoredFile {
  data: Uint8Array
  etag: string
}

export interface FakeOptions {
  /** Answer without ETags, like a server whose writes cannot be made conditional. */
  noEtag?: boolean
  /** Keep only this many bytes of every PUT body, to simulate a write cut short. */
  truncate?: number
  /** Answer 409 for a read in a folder that is not there (坚果云). */
  readMissingAs409?: boolean
  /** Answer 403 for anything in a folder that is not there (Synology). */
  forbiddenWhenMissing?: boolean
  /** Answer 405 for HEAD, so the size must come from PROPFIND. */
  noHead?: boolean
  /** Answer 404 rather than 409 for a write into a folder that is not there. */
  putMissingAs404?: boolean
  /** Answer 403 for a file that is not there, even when the folder is. */
  forbiddenFile?: boolean
  /**
   * Answer this status to a PROPFIND for a collection that is not there,
   * instead of 404. A server refusing a path it cannot parse — a doubled slash,
   * say — answers 400, which must not be read as "nothing is there yet".
   */
  folderProbeStatus?: number
  /** Rate-limit this many requests, then behave. */
  rateLimit?: { times: number; retryAfter?: string }
  /** Report a Content-Length of 0 on HEAD even for a stored file (坚果云, #1259). */
  headLengthZero?: boolean
  /**
   * Answer PROPFIND without a `getcontentlength` at all — a server that lists the
   * resource but says nothing about its size, which is the one case where a HEAD's
   * zero cannot be checked against anything else.
   */
  noPropfindLength?: boolean
  /**
   * Behave like an OpenList/Alist `/dav/` root: it is a list of storages, so
   * MKCOL answers 405 (nothing new can be made) and a write below an unknown
   * folder answers 404. `collections` names the storages it lists.
   */
  storageList?: boolean
  /**
   * Stamp every answer with a Date and a Last-Modified this many seconds
   * before it, and send no ETag. Zero or less means the stamp is this very
   * second — which is a version no write may be matched against.
   */
  lastModifiedSeconds?: number
}

export interface Call {
  method: string
  path: string
  headers: Record<string, string>
}

/** The path a request named, without host or query. */
function pathOf(input: unknown): string {
  const raw = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input)
  try {
    return new URL(raw).pathname
  } catch {
    return raw
  }
}

function bodyOf(init: RequestInit | undefined): Promise<Uint8Array> {
  const body = init?.body
  if (body === undefined || body === null) return Promise.resolve(new Uint8Array())
  if (typeof body === 'string') return Promise.resolve(new TextEncoder().encode(body))
  if (body instanceof Uint8Array) return Promise.resolve(body)
  if (body instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(body))
  if (typeof (body as Blob).arrayBuffer === 'function') {
    return (body as Blob).arrayBuffer().then(buffer => new Uint8Array(buffer))
  }
  return Promise.resolve(new Uint8Array())
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  const headers = init?.headers
  if (headers === undefined) return out
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value
    })
    return out
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[String(key).toLowerCase()] = String(value)
    return out
  }
  for (const [key, value] of Object.entries(headers as Record<string, string>)) out[key.toLowerCase()] = String(value)
  return out
}

export class FakeDav {
  /** Files, keyed by path. */
  readonly files = new Map<string, StoredFile>()
  /** Collection paths that exist. */
  readonly collections = new Set<string>()
  /** Every request the plugin made, in order. */
  readonly calls: Call[] = []

  private counter = 0
  private limited: number
  private saved: typeof globalThis.fetch | undefined

  constructor(readonly options: FakeOptions = {}) {
    this.limited = options.rateLimit?.times ?? 0
    const base = new URL('https://dav.test/dav')
    this.collections.add(base.pathname)
  }

  /** Swap `globalThis.fetch` for this server; the answer puts it back. */
  use(): () => void {
    this.saved = globalThis.fetch
    globalThis.fetch = ((input: unknown, init?: RequestInit) => this.handle(input, init)) as typeof globalThis.fetch
    return () => {
      if (this.saved !== undefined) globalThis.fetch = this.saved
      this.saved = undefined
    }
  }

  /** Seed a file as if another computer had written it. */
  seed(path: string, body: string | Uint8Array): StoredFile {
    const data = typeof body === 'string' ? new TextEncoder().encode(body) : body
    this.counter += 1
    const file: StoredFile = { data, etag: `"v${this.counter}"` }
    this.files.set(pathOf(path), file)
    for (const parent of parents(pathOf(path))) this.collections.add(parent)
    return file
  }

  /** The body stored at a path, as text. */
  text(path: string): string | undefined {
    const file = this.files.get(pathOf(path))
    return file === undefined ? undefined : new TextDecoder().decode(file.data)
  }

  /** Make a collection that already exists, as a server's own folders do. */
  seedCollection(path: string): void {
    for (const parent of parents(pathOf(path))) this.collections.add(parent)
    this.collections.add(pathOf(path).replace(/\/+$/, ''))
  }

  /** Every request path this server saw for one method. */
  pathsFor(method: string): string[] {
    return this.calls.filter(call => call.method === method).map(call => call.path)
  }

  private async handle(input: unknown, init?: RequestInit): Promise<Response> {
    const path = pathOf(input)
    const headers = headersOf(init)
    const method = (init?.method ?? 'GET').toUpperCase()
    this.calls.push({ method, path, headers })

    if (this.limited > 0) {
      this.limited -= 1
      const response = new Response(null, { status: 429 })
      if (this.options.rateLimit?.retryAfter !== undefined) {
        response.headers.set('retry-after', this.options.rateLimit.retryAfter)
      }
      return response
    }

    const file = this.files.get(path)
    const collection = this.collections.has(path.replace(/\/+$/, '')) || this.collections.has(path)
    const folder = this.folderOf(path)
    const folderThere = this.collections.has(folder)

    switch (method) {
      case 'GET': {
        if (file === undefined) {
          if (this.options.forbiddenWhenMissing === true && !folderThere) return new Response(null, { status: 403 })
          if (this.options.readMissingAs409 === true) return new Response(null, { status: 409 })
          return new Response(null, { status: 404 })
        }
        const match = headers['if-none-match']
        if (match !== undefined && match === file.etag) return new Response(null, { status: 304 })
        const since = headers['if-modified-since']
        if (since !== undefined) return new Response(null, { status: 304 })
        const response = new Response(new Uint8Array(file.data), { status: 200 })
        if (this.options.noEtag !== true) response.headers.set('etag', file.etag)
        this.stamp(response)
        return response
      }
      case 'PUT': {
        const want = headers['if-match']
        if (want !== undefined && want !== '' && (file === undefined || file.etag !== want)) {
          return new Response(null, { status: 412 })
        }
        if (this.options.forbiddenWhenMissing === true && !folderThere) return new Response(null, { status: 403 })
        if (this.options.readMissingAs409 === true && !folderThere) return new Response(null, { status: 409 })
        // A storage-list root has no folder to write into: its children are
        // storages, and only they can hold a file.
        if (this.options.storageList === true && !folderThere && !collection) return new Response(null, { status: 404 })
        // RFC 4918: a file cannot be written into a collection that is not
        // there, which is what a real server answers for a first sync.
        if (!folderThere) {
          if (this.options.putMissingAs404 === true) return new Response(null, { status: 404 })
          return new Response(null, { status: 409 })
        }
        let data = await bodyOf(init)
        if (this.options.truncate !== undefined) data = data.slice(0, this.options.truncate)
        this.counter += 1
        const stored: StoredFile = { data, etag: `"v${this.counter}"` }
        this.files.set(path, stored)
        for (const parent of parents(path)) this.collections.add(parent)
        const response = new Response(null, { status: 201 })
        if (this.options.noEtag !== true) response.headers.set('etag', stored.etag)
        return response
      }
      case 'HEAD': {
        if (this.options.noHead === true) return new Response(null, { status: 405 })
        if (file === undefined) return new Response(null, { status: 404 })
        const response = new Response(null, { status: 200 })
        response.headers.set('content-length', this.options.headLengthZero === true ? '0' : String(file.data.byteLength))
        if (this.options.noEtag !== true) response.headers.set('etag', file.etag)
        return response
      }
      case 'PROPFIND': {
        const depth = headers.depth ?? '0'
        if (depth === '0') {
          if (file !== undefined) {
            const size = this.options.noPropfindLength === true ? undefined : file.data.byteLength
            return new Response(multistatus([{ href: path, length: size }]), { status: 207 })
          }
          // Whether THIS path is a collection, not whether the folder around
          // it is: a client asks about a collection that does not exist yet.
          if (collection) {
            return new Response(multistatus([{ href: path, collection: true }]), { status: 207 })
          }
          // Synology answers 403 for a collection that is not there as well as
          // for one the account may not use, which is why the client probes.
          if (this.options.forbiddenWhenMissing === true) return new Response(null, { status: 403 })
          if (this.options.folderProbeStatus !== undefined) {
            return new Response(null, { status: this.options.folderProbeStatus })
          }
          return new Response(null, { status: 404 })
        }
        const prefix = path.replace(/\/+$/, '')
        const children: Array<{ href: string; collection?: boolean; length?: number }> = [
          { href: `${prefix}/`, collection: true },
        ]
        for (const [name, value] of this.files) {
          if (name === path) children.push({ href: name, length: value.data.byteLength })
          else if (dirOf(name) === prefix) children.push({ href: name, length: value.data.byteLength })
        }
        for (const name of this.collections) {
          if (name !== prefix && dirOf(name) === prefix) children.push({ href: `${name}/`, collection: true })
        }
        return new Response(multistatus(children), { status: 207 })
      }
      case 'MKCOL': {
        // A storage-list root answers 405: it holds storages, not folders a
        // client may make.
        if (this.options.storageList === true) return new Response(null, { status: 405 })
        const clean = path.replace(/\/+$/, '')
        if (this.collections.has(clean)) return new Response(null, { status: 405 })
        // RFC 4918: a collection cannot be made inside one that is not there.
        if (!this.collections.has(dirOf(clean))) return new Response(null, { status: 409 })
        this.collections.add(clean)
        return new Response(null, { status: 201 })
      }
      default:
        return new Response(null, { status: 405 })
    }
  }

  /** The collection a path sits in. */
  private folderOf(path: string): string {
    return dirOf(path.replace(/\/+$/, ''))
  }

  /**
   * Give an answer the Date/Last-Modified pair a real server sends. A version
   * may only be taken from Last-Modified when it is a full second or more
   * before the server's own clock, so both are needed to exercise that rule.
   */
  private stamp(response: Response): void {
    const seconds = this.options.lastModifiedSeconds
    if (seconds === undefined) return
    const now = Date.now()
    response.headers.set('date', new Date(now).toUTCString())
    response.headers.set('last-modified', new Date(now - seconds * 1000).toUTCString())
  }
}

/** The directory a path sits in. */
function dirOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut <= 0 ? '' : path.slice(0, cut)
}

/** Every ancestor collection of a path. */
function parents(path: string): string[] {
  const out: string[] = []
  let at = dirOf(path.replace(/\/+$/, ''))
  while (at !== '' && at !== '/') {
    out.push(at)
    at = dirOf(at)
  }
  if (out.length === 0) out.push('/')
  return out
}

/** A 207 body naming the given resources. */
function multistatus(
  entries: ReadonlyArray<{ href: string; collection?: boolean; length?: number }>,
): string {
  const parts = entries.map(entry => {
    const props =
      entry.collection === true
        ? '<D:resourcetype><D:collection/></D:resourcetype>'
        : entry.length === undefined
          ? '<D:resourcetype/>'
          : `<D:resourcetype/><D:getcontentlength>${entry.length}</D:getcontentlength>`
    return `<D:response><D:href>${entry.href}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  })
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${parts.join('')}</D:multistatus>`
}

/** A stable digest of some bytes, for the tests that compare bodies. */
export function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}
