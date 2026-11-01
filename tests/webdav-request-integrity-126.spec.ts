import type { IncomingMessage } from 'node:http'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { beforeAll, describe, expect, it } from 'vitest'
import { isTrustedRequest, type TrustedWebdavRequest } from '../src/trusted-request.js'

// Source text only: NEVER import the release index/apply/engine/relay or real model index.
// The real captured route/send/readJson expressions run against in-memory mock requests.
// Every body and header below is synthetic; no sockets, config APIs, credentials or .prop IO.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = join(repo, '.verify', 'webdav-1.2.6')
const originalPath = join(fixtures, 'index.original.js')
const hardenedPath = join(fixtures, 'index.hardened.js')
const supplierPath = join(fixtures, 'plugin-config.hardened.js')
const fencePath = join(fixtures, 'trusted-request.js')
const referencePath = join(fixtures, 'model-request-policy.js')
const available = [originalPath, hardenedPath, supplierPath, fencePath, referencePath].every(existsSync)
const POLICY = '20261101-key-index-union+realm-lease+origin-boundary'
const HEADER = 'x-dsh-webdav-key-integrity'
const STATUS = '/plugin/webdav-sync/status'
const BODY_LIMIT = 64 * 1024
const HOST = '127.0.0.1:11061'
type Headers = TrustedWebdavRequest['headers']
const cases: [string, Headers, boolean][] = [
  ['local CLI without Origin', { host: HOST }, true],
  ['same authority', { host: HOST, origin: `http://${HOST}` }, true],
  ['localhost is case normalized', { host: 'LOCALHOST:11061', origin: 'http://localhost:11061' }, true],
  ['default port is normalized', { host: '127.0.0.1:80', origin: 'http://127.0.0.1' }, true],
  ['IPv6 loopback', { host: '[::1]:11061', origin: 'http://[::1]:11061' }, true],
  ['existing policy keeps literal LAN IPv4', { host: '192.168.0.2:11061', origin: 'http://192.168.0.2:11061' }, true],
  ['existing policy keeps literal LAN IPv6', { host: '[fd00::1]:11061', origin: 'http://[fd00::1]:11061' }, true],
  ['same-site is not needed to admit same authority', { host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'same-site' }, true],
  ['no browser Origin with none marker', { host: HOST, 'sec-fetch-site': 'none' }, true],
  ['missing Host', {}, false],
  ['empty Host', { host: '' }, false],
  ['Host container is not authority', { host: [HOST] }, false],
  ['invalid Host whitespace inside hostname', { host: 'bad host:11061' }, false],
  ['invalid Host port', { host: '127.0.0.1:invalid' }, false],
  ['invalid Host port overflow', { host: '127.0.0.1:99999' }, false],
  ['invalid IPv6 literal', { host: '[not-ip]:11061' }, false],
  ['unbracketed IPv6 authority', { host: '::1' }, false],
  ['named DNS host has no trust escape hatch', { host: 'attacker.example.invalid:11061' }, false],
  ['numeric prefix is not an IP literal', { host: '127.0.0.1.attacker.invalid:11061' }, false],
  ['localhost suffix is not loopback', { host: 'localhost.attacker.invalid:11061' }, false],
  ['rebound matching domain Origin is still refused', { host: 'rebind.example.invalid:11061', origin: 'http://rebind.example.invalid:11061', 'sec-fetch-site': 'same-origin' }, false],
  ['Origin host mismatch', { host: HOST, origin: 'http://attacker.example.invalid' }, false],
  ['Origin port mismatch', { host: HOST, origin: 'http://127.0.0.1:11062' }, false],
  ['serialized null Origin', { host: HOST, origin: 'null' }, false],
  ['invalid Origin URL', { host: HOST, origin: 'not a URL' }, false],
  ['cross-site without Origin is refused', { host: HOST, 'sec-fetch-site': 'cross-site' }, false],
  ['cross-site matching Origin is still refused', { host: HOST, origin: `http://${HOST}`, 'sec-fetch-site': 'cross-site' }, false],
  ['same-site cannot admit mismatched Origin', { host: HOST, origin: 'http://localhost:11061', 'sec-fetch-site': 'same-site' }, false],
]

describe('pure WebDAV request fence uses the existing model policy', () => {
  it.each(cases)('%s', (_name, headers, expected) => {
    expect(isTrustedRequest({ headers })).toBe(expected)
  })
})

type Counters = { method: number; parse: number; handle: number; engine: number; relay: number; resume: number; trace: string[]; body: unknown }
function counters(): Counters { return { method: 0, parse: 0, handle: 0, engine: 0, relay: 0, resume: 0, trace: [], body: undefined } }
class MockRequest extends EventEmitter implements TrustedWebdavRequest {
  constructor(readonly headers: Headers, private readonly requestMethod: string, private readonly text: string, readonly counts: Counters) { super() }
  get method(): string { this.counts.method++; this.counts.trace.push('method'); return this.requestMethod }
  resume(): this { this.counts.resume++; this.counts.trace.push('resume'); return this }
  feed(): void { if (this.text !== '') this.emit('data', Buffer.from(this.text)); this.emit('end') }
}
class MockResponse {
  readonly headers = new Map<string, string>()
  status = 0
  text = ''
  constructor(readonly counts: Counters) {}
  setHeader(name: string, value: string): void { this.counts.trace.push(`header:${name}`); this.headers.set(name.toLowerCase(), value) }
  writeHead(status: number, headers: Record<string, string>): void { this.status = status; for (const [name, value] of Object.entries(headers)) this.headers.set(name.toLowerCase(), value) }
  end(text: string): void { this.text = text }
  get body(): unknown { return JSON.parse(this.text) }
}
type Handler = (req: MockRequest, res: MockResponse) => Promise<void>
type Handle = (req: MockRequest, res: MockResponse, body: unknown) => Promise<unknown>
type Registered = { path: string; kind: string; label: string; handler: Handler }
type Send = (res: MockResponse, status: number, body: unknown, headers?: Record<string, string>) => void
type Parser = (req: MockRequest, limit?: number) => Promise<unknown>
type Factory = (path: string, label: string, handle: Handle, limit?: number) => void
type Fence = (req: TrustedWebdavRequest) => boolean
let expressions: Map<string, string>
let send: Send
let parser: Parser
let compiledFence: Fence
let modelFence: (req: IncomingMessage) => boolean
let marker: string

function initializer(source: string, name: string): string {
  const tree = ts.createSourceFile('captured-index.js', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer !== undefined) found.push(node.initializer.getText(tree))
    ts.forEachChild(node, visit)
  }
  visit(tree)
  expect(found, `one captured initializer for ${name}`).toHaveLength(1)
  return found[0] ?? ''
}

async function invoke(headers: Headers, method = 'POST', body = '{', path = '/plugin/webdav-sync/config', limit = BODY_LIMIT): Promise<{ req: MockRequest; res: MockResponse; counts: Counters }> {
  const counts = counters()
  const req = new MockRequest(headers, method, body, counts)
  const res = new MockResponse(counts)
  let registered: Registered | undefined
  const webCtx = {
    effect: (effect: () => () => void, _label: string): void => { effect() },
    webServer: { register: (spec: Registered): (() => void) => { registered = spec; return () => undefined } },
  }
  const readJson: Parser = (request, maximum) => {
    counts.parse++; counts.trace.push('readJson')
    const pending = parser(request, maximum)
    queueMicrotask(() => request.feed())
    return pending
  }
  const factory = new Function('webCtx', 'ROUTE_STATUS', 'BODY_LIMIT', 'send', 'readJson', 'isTrustedRequest', 'KEY_INDEX_INTEGRITY_POLICY', `return (${expressions.get('route')});`)(webCtx, STATUS, BODY_LIMIT, send, readJson, compiledFence, marker) as Factory
  const handle: Handle = async (_req, _res, parsed) => {
    counts.handle++; counts.engine++; counts.relay++; counts.body = parsed
    // The real wrapper delegates response writing to handle; its return is ignored.
    send(_res, 200, { mock: true })
    return undefined
  }
  factory(path, 'synthetic captured route', handle, limit)
  expect(registered?.path).toBe(path)
  expect(registered?.kind).toBe('exact')
  if (registered === undefined) throw new Error('captured route did not register')
  await registered.handler(req, res)
  return { req, res, counts }
}

describe.skipIf(!available)('accurate 1.2.6 captured wrapper, no engine/bootstrap/credential IO', () => {
  beforeAll(async () => {
    const original = await readFile(originalPath, 'utf8')
    const hardened = await readFile(hardenedPath, 'utf8')
    const patch = JSON.parse(await readFile(join(repo, 'src', 'webdav-request-integrity-patch.json'), 'utf8')) as { targetSha256: string; integrityPolicy: string; edits: { oldText: string; newText: string }[] }
    expect(createHash('sha256').update(original).digest('hex')).toBe('69ddb92b8a419aed7d2726cf7452080762136d998a6d60b61bb5650a877ccdeb')
    expect(patch.targetSha256).toBe(createHash('sha256').update(original).digest('hex'))
    expect(patch.edits).toHaveLength(2)
    let rebuilt = original
    for (const edit of patch.edits) { expect(rebuilt.split(edit.oldText)).toHaveLength(2); rebuilt = rebuilt.replace(edit.oldText, edit.newText) }
    expect(hardened).toBe(rebuilt)
    expressions = new Map(['route', 'send', 'readJson'].map(name => [name, initializer(hardened, name)]))
    expect(expressions.get('send')).toBe(initializer(original, 'send'))
    expect(expressions.get('readJson')).toBe(initializer(original, 'readJson'))
    send = new Function(`return (${expressions.get('send')});`)() as Send
    parser = new Function('BODY_LIMIT', `return (${expressions.get('readJson')});`)(BODY_LIMIT) as Parser
    compiledFence = (await import(pathToFileURL(fencePath).href) as { isTrustedRequest: Fence }).isTrustedRequest
    modelFence = (await import(pathToFileURL(referencePath).href) as { isTrustedRequest: (req: IncomingMessage) => boolean }).isTrustedRequest
    marker = (await import(pathToFileURL(supplierPath).href) as { KEY_INDEX_INTEGRITY_POLICY: string }).KEY_INDEX_INTEGRITY_POLICY
    expect(marker).toBe(POLICY)
    expect(patch.integrityPolicy).toBe(marker)
  })

  it('compiled fence agrees with the pure captured model-policy reference', () => {
    for (const [name, headers, expected] of cases) {
      expect(compiledFence({ headers }), name).toBe(expected)
      expect(modelFence({ headers } as IncomingMessage), name).toBe(expected)
    }
  })

  it('policy supplier also rebuilds exactly from its original 535 snapshot', async () => {
    const original = await readFile(join(fixtures, 'plugin-config.original.js'), 'utf8')
    const patch = JSON.parse(await readFile(join(repo, 'src', 'key-index-plugin-config-patch.json'), 'utf8')) as { integrityPolicy: string; edits: { oldText: string; newText: string }[] }
    let rebuilt = original
    for (const edit of patch.edits) { expect(rebuilt.split(edit.oldText)).toHaveLength(2); rebuilt = rebuilt.replace(edit.oldText, edit.newText) }
    expect(await readFile(supplierPath, 'utf8')).toBe(rebuilt)
    expect(patch.integrityPolicy).toBe(marker)
  })

  it.each(cases.filter(([_name, _headers, expected]) => !expected))('rejects %s before method/body/handle/engine/relay', async (_name, headers) => {
    const { res, counts } = await invoke(headers)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: '请求来源不受信任' })
    expect(res.headers.get(HEADER)).toBe(POLICY)
    expect(counts).toMatchObject({ method: 0, parse: 0, handle: 0, engine: 0, relay: 0, resume: 1 })
    expect(counts.trace[0]).toBe(`header:${HEADER}`)
  })

  it.each(['/plugin/webdav-sync/config', '/plugin/webdav-sync/sync', '/plugin/webdav-sync/restore', STATUS])('guards the shared route for %s including wrong method', async path => {
    const { res, counts } = await invoke({ host: HOST, origin: 'http://example.invalid', 'sec-fetch-site': 'cross-site' }, 'DELETE', '{', path)
    expect(res.status).toBe(403)
    expect(res.headers.get(HEADER)).toBe(POLICY)
    expect(counts).toMatchObject({ method: 0, parse: 0, handle: 0, engine: 0, relay: 0 })
  })

  it.each([['trusted no Origin', { host: HOST }], ['trusted same Origin', { host: HOST, origin: `http://${HOST}` }]] as [string, Headers][])('%s malformed body preserves 400 plus marker without handle effects', async (_name, headers) => {
    const { res, counts } = await invoke(headers)
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: expect.stringContaining('请求内容不是合法的 JSON：') })
    expect(res.headers.get(HEADER)).toBe(POLICY)
    expect(counts).toMatchObject({ method: 1, parse: 1, handle: 0, engine: 0, relay: 0 })
    expect(counts.trace[0]).toBe(`header:${HEADER}`)
  })

  it('trusted wrong method keeps 405/Allow without parsing', async () => {
    const { res, counts } = await invoke({ host: HOST }, 'GET')
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
    expect(res.headers.get(HEADER)).toBe(POLICY)
    expect(counts).toMatchObject({ parse: 0, handle: 0, engine: 0, relay: 0, resume: 1 })
  })

  it('trusted valid synthetic body keeps existing callback contract', async () => {
    const { res, counts } = await invoke({ host: HOST }, 'POST', '{"synthetic":true}')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ mock: true })
    expect(counts).toMatchObject({ parse: 1, handle: 1, engine: 1, relay: 1, body: { synthetic: true } })
  })

  it('trusted size limit is unchanged after the fence', async () => {
    const { res, counts } = await invoke({ host: HOST }, 'POST', '{"synthetic":true}', '/synthetic/import', 1)
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: '请求内容过大' })
    expect(counts).toMatchObject({ parse: 1, handle: 0, engine: 0, relay: 0 })
  })
})
