/**
 * The WebDAV client, against a server that misbehaves the way real ones do.
 *
 * Every quirk exercised here was paid for once already, in the app this plugin
 * is modelled on: a server that answers 409 for a read in a missing folder, one
 * that answers 403 instead of 404, one that reports a stored file's length as
 * zero, one that has no ETags at all, and one that cuts a long write short.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { ChangedError, Dav, LoginError, RateLimitedError } from '../src/dav.ts'
import { FakeDav } from './fake-dav.ts'

const BASE = 'https://dav.test/dav'
const DIRECTORY = `${BASE}/dsh-webdav`
const FILE = `${DIRECTORY}/dsh-profile.dshsync`
/** The fake keys its collections by path, not by address. */
const DIRECTORY_PATH = '/dav/dsh-webdav'

let stop: (() => void) | undefined

afterEach(() => {
  stop?.()
  stop = undefined
})

function serve(options = {}): FakeDav {
  const dav = new FakeDav(options)
  stop = dav.use()
  return dav
}

function client(over: { url?: string; user?: string; password?: string } = {}): Dav {
  return new Dav({ url: BASE, user: '', password: '', ...over })
}

describe('the address', () => {
  it('accepts an http or https folder and drops the trailing slashes', () => {
    expect(client().address).toBe(BASE)
    expect(new Dav({ url: `${BASE}/`, user: '', password: '' }).address).toBe(BASE)
    expect(new Dav({ url: 'http://dav.test/dav', user: '', password: '' }).address).toBe('http://dav.test/dav')
  })

  it('refuses anything that is not a WebDAV address', () => {
    for (const url of ['', 'dav.test/dav', 'ftp://dav.test/dav', 'https://', 'not a url']) {
      expect(() => new Dav({ url, user: '', password: '' })).toThrow(/不是 WebDAV 地址/)
    }
  })

  it('never lets credentials ride along in the address it reports', () => {
    const dav = new Dav({ url: 'https://user:secret@dav.test/dav', user: '', password: '' })
    expect(dav.address).toBe(BASE)
    expect(dav.address).not.toContain('secret')
  })

  it('builds the file address out of the folder', () => {
    expect(client().fileUrl).toBe(FILE)
    expect(client().url('other', 'thing.bin')).toBe(`${BASE}/other/thing.bin`)
  })

  it('builds one slash, never two, when the address is a server root', () => {
    // A URL cannot hold an empty pathname — assigning '' puts the '/' back — so
    // joining onto it used to produce `//dsh-webdav/...`, which real servers
    // (WsgiDAV among them) answer 400 to. Any address without a path is affected.
    for (const url of ['https://dav.test', 'https://dav.test/', 'https://dav.test:8443', 'https://dav.test:8443/']) {
      const dav = new Dav({ url, user: '', password: '' })
      const root = url.replace(/\/+$/, '')
      expect(dav.fileUrl).toBe(`${root}/dsh-webdav/dsh-profile.dshsync`)
      expect(dav.url('dsh-webdav')).toBe(`${root}/dsh-webdav`)
      expect(dav.fileUrl.replace(/^https?:\/\//, '')).not.toContain('//')
    }
  })

  it('appends to a folder address without doubling its slash either', () => {
    for (const url of ['https://dav.test/dav', 'https://dav.test/dav/', 'https://dav.test/a/b/']) {
      const dav = new Dav({ url, user: '', password: '' })
      const root = url.replace(/\/+$/, '')
      expect(dav.fileUrl).toBe(`${root}/dsh-webdav/dsh-profile.dshsync`)
    }
  })
})

describe('get', () => {
  it('reads a file that is there, and remembers its version', async () => {
    const dav = serve()
    dav.seed(FILE, 'hello')
    const read = await client().get()
    expect(new TextDecoder().decode(read.data)).toBe('hello')
    expect(read.version.etag).toBe('"v1"')
    expect(read.notModified).toBeUndefined()
  })

  it('asks with the version it last saw and takes 304 as "unchanged"', async () => {
    const dav = serve()
    dav.seed(FILE, 'hello')
    const first = await client().get()
    const second = await client().get(first.version)
    expect(second.notModified).toBe(true)
    expect(second.data).toBeUndefined()
    const call = dav.calls.find((entry) => entry.method === 'GET' && entry.headers['if-none-match'] !== undefined)
    expect(call?.headers['if-none-match']).toBe('"v1"')
  })

  it('asks for an identity encoding, so the ETag stays the one a write can match', async () => {
    // A compressing server rewrites the ETag (Apache appends -gzip inside the
    // quotes, nginx weakens it to W/"..."), and then every conditional write
    // over it is refused. Asking for identity is what keeps them working.
    const dav = serve()
    dav.seed(FILE, 'hello')
    await client().get()
    const call = dav.calls.find((entry) => entry.method === 'GET')
    expect(call?.headers['accept-encoding']).toBe('identity')
  })

  it('reports a missing file as an empty read, whatever status says so', async () => {
    // 409 is how 坚果云 answers a read in a folder that is not there yet.
    const dav = serve({ readMissingAs409: true })
    const read = await client().get()
    expect(read.data).toBeUndefined()
    expect(read.notModified).toBeUndefined()
    expect(read.version.etag).toBeUndefined()
  })

  it('treats a 403 with no folder under it as an empty read, not a failure', async () => {
    // Synology answers 403 rather than 404 for a missing collection, and the
    // state before a first sync is exactly that: no folder.
    serve({ forbiddenWhenMissing: true })
    const read = await client().get()
    expect(read.data).toBeUndefined()
    expect(read.notModified).toBeUndefined()
  })

  it('refuses a file larger than it will hold in memory', async () => {
    const dav = serve()
    dav.seed(FILE, new Uint8Array(64 * 1024 * 1024 + 1))
    await expect(client().get()).rejects.toThrow(/超过/)
  }, 30_000)

  it('says where a redirect went instead of following it silently', async () => {
    const dav = serve()
    dav.seed(FILE, 'hello')
    const davClient = client()
    const original = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await original(input, init)
      Object.defineProperty(response, 'redirected', { value: true })
      Object.defineProperty(response, 'url', { value: 'https://other.test/somewhere/else?token=secret' })
      return response
    }
    try {
      const read = await davClient.get()
      expect(read.redirectedTo).toBe('other.test/somewhere/else')
      void dav
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('put', () => {
  it('writes the bytes, makes the folder, and hands back the new version', async () => {
    const dav = serve()
    const version = await client().put(new TextEncoder().encode('first'))
    expect(dav.text(FILE)).toBe('first')
    expect(version.etag).toBeDefined()
    expect(dav.collections.has(DIRECTORY_PATH)).toBe(true)
  })

  it('sends an If-Match once it has read a version, so a write cannot clobber a newer file', async () => {
    const dav = serve()
    dav.seed(FILE, 'old')
    const read = await client().get()
    await client().put(new TextEncoder().encode('new'), read.version.etag)
    const put = dav.calls.find((entry) => entry.method === 'PUT')
    expect(put?.headers['if-match']).toBe('"v1"')
  })

  it('turns a refused conditional write into "it changed meanwhile"', async () => {
    const dav = serve()
    dav.seed(FILE, 'old')
    await expect(client().put(new TextEncoder().encode('new'), '"stale"')).rejects.toBeInstanceOf(ChangedError)
  })

  it('makes the folder and tries again when the first write finds nowhere to go', async () => {
    const dav = serve()
    // The folder is missing, and this server says 409 rather than 404.
    dav.collections.delete(DIRECTORY_PATH)
    const version = await client().put(new TextEncoder().encode('first'))
    expect(version.etag).toBeDefined()
    expect(dav.text(FILE)).toBe('first')
  })

  it('verifies the write and gives up after three tries at a server that keeps cutting it short', async () => {
    const dav = serve({ truncate: 3 })
    dav.seedCollection(DIRECTORY)
    await expect(client().put(new TextEncoder().encode('a long body'))).rejects.toThrow(/3\/11 字节/)
    expect(dav.pathsFor('PUT').length).toBe(3)
  })

  it('does not mistake a server that reports a zero length for a cut-short write', async () => {
    // 坚果云 answers Content-Length: 0 on HEAD for a file it holds in full.
    const dav = serve({ headLengthZero: true })
    dav.seedCollection(DIRECTORY)
    const version = await client().put(new TextEncoder().encode('a long body'))
    expect(version.etag).toBeDefined()
    expect(dav.text(FILE)).toBe('a long body')
    expect(dav.pathsFor('PUT').length).toBe(1)
  })

  it('does not mistake an absent HEAD for a cut-short write', async () => {
    const dav = serve({ noHead: true })
    dav.seedCollection(DIRECTORY)
    const version = await client().put(new TextEncoder().encode('a long body'))
    expect(version.etag).toBeDefined()
    expect(dav.text(FILE)).toBe('a long body')
    expect(dav.pathsFor('PUT').length).toBe(1)
  })

  it('returns no version at all when the server sends no ETag', async () => {
    serve({ noEtag: true })
    expect(await client().put(new TextEncoder().encode('x'))).toEqual({})
  })
})

describe('stat', () => {
  it('reports a file that is there and its size', async () => {
    const dav = serve()
    dav.seed(FILE, 'hello')
    expect(await client().stat()).toEqual({ exists: true, size: 5 })
  })

  it('gets the size from PROPFIND when HEAD reports a zero length', async () => {
    const dav = serve({ headLengthZero: true })
    dav.seed(FILE, 'hello')
    expect(await client().stat()).toEqual({ exists: true, size: 5 })
  })

  it('gets the size from PROPFIND when the server has no HEAD at all', async () => {
    const dav = serve({ noHead: true })
    dav.seed(FILE, 'hello')
    expect(await client().stat()).toEqual({ exists: true, size: 5 })
  })

  it('reports no file when there is none', async () => {
    serve()
    expect(await client().stat()).toEqual({ exists: false })
  })
})

describe('check', () => {
  it('passes when the folder answers, and makes the plugin folder', async () => {
    const dav = serve()
    await expect(client().check()).resolves.toEqual({ ok: true })
    expect(dav.collections.has(DIRECTORY_PATH)).toBe(true)
  })

  it('explains a missing address rather than reporting a bare status', async () => {
    const dav = serve()
    // The address itself is not there: nothing can be made under it.
    dav.collections.delete('/dav')
    await expect(client().check()).rejects.toThrow(/没有目录 \/dav/)
  })

  it('refuses to call itself fine when the folder probe is answered with a refusal', async () => {
    // A doubled slash once made the folder probe answer 400, and the check
    // reported "the server answered" while every later sync failed with it.
    serve({ folderProbeStatus: 400 })
    await expect(client().check()).rejects.toThrow(/对 \/dav 里的目录 dsh-webdav 回答了 400/)
  })

  it('reports a refused sign-in as such', async () => {
    serve()
    const davClient = client({ user: 'me', password: 'wrong' })
    const original = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      if (headers.get('authorization') !== null) return new Response(null, { status: 401 })
      return original(input, init)
    }
    try {
      await expect(davClient.check()).rejects.toBeInstanceOf(LoginError)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('servers that limit how often they are reached', () => {
  it('reports a 429 with the wait the server asked for', async () => {
    serve({ rateLimit: { times: 99, retryAfter: '120' } })
    const failure = await client().get().catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(RateLimitedError)
    expect((failure as RateLimitedError).after).toBe(120_000)
    expect((failure as RateLimitedError).message).toMatch(/限制了本机的访问频率/)
  })

  it('reads a Retry-After given as a date', async () => {
    const when = new Date(Date.now() + 60_000).toUTCString()
    serve({ rateLimit: { times: 99, retryAfter: when } })
    const failure = await client().get().catch((cause: unknown) => cause)
    expect((failure as RateLimitedError).after).toBeGreaterThan(0)
    expect((failure as RateLimitedError).after).toBeLessThanOrEqual(60_000)
  })

  it('carries no wait when the server named none', async () => {
    serve({ rateLimit: { times: 99 } })
    const failure = await client().get().catch((cause: unknown) => cause)
    expect((failure as RateLimitedError).after).toBe(0)
  })
})

describe('the folder a file lives in', () => {
  it('treats a collection that is already there as success', async () => {
    const dav = serve()
    dav.seedCollection(DIRECTORY)
    await expect(client().mkcol()).resolves.toBeUndefined()
    expect(dav.collections.has(DIRECTORY_PATH)).toBe(true)
  })

  it('names the sibling storages when the address is a storage list', async () => {
    // An OpenList/Alist root answers MKCOL with 405 and the file PUT with 404,
    // so the address has to go into one of the storages it lists.
    const dav = serve({ storageList: true })
    dav.seedCollection(`${BASE}/my-drive`)
    const failure = await client().put(new TextEncoder().encode('x')).catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/无处安放目录 dsh-webdav/)
    expect((failure as Error).message).toMatch(/my-drive/)
  })

  it('says the folder above is missing when the server refuses to make it', async () => {
    const dav = serve()
    dav.collections.delete('/dav')
    await expect(client().mkcol()).rejects.toThrow(/没有目录 \/dav/)
  })
})

describe('a version taken from Last-Modified', () => {
  it('is used when it is a second or more before the server said it', async () => {
    const dav = serve({ noEtag: true, lastModifiedSeconds: 5 })
    dav.seed(FILE, 'hello')
    const read = await client().get()
    expect(read.version.modified).toBeDefined()
    // The next read asks with it, and the server answers "unchanged".
    const again = await client().get(read.version)
    expect(again.notModified).toBe(true)
  })

  it('is refused when it is this very second, so a write cannot go unseen', async () => {
    serve({ noEtag: true, lastModifiedSeconds: 0 })
    const read = await client().get()
    expect(read.version).toEqual({})
  })
})
