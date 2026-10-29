/**
 * The host half's configuration writer.
 *
 * `configure` is where a card's form lands, and it is the only place that
 * decides what a blank secret field means. Every case here is about a value the
 * card cannot see and therefore cannot send back: what happens to a stored
 * password when the form says nothing about it, and when it says something about
 * the address instead.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { apply, configure } from '../src/index.ts'
import * as engines from '../src/engine.ts'
import { engineFor, pathsOf, viewOf } from '../src/engine.ts'
import { open } from '../src/crypto.ts'
import type { CredentialService } from '../src/keys.ts'
import { defaultConfig, heldPassword, loadConfig, normaliseConfig, persistConfig, saveConfig } from '../src/state.ts'
import { cleanUp, configFor, tempDir, writeProfile } from './harness.ts'
import { FakeDav, type FakeOptions } from './fake-dav.ts'
import { DIRS_MAX, ROUTE_STATUS, type Bundle, type StatusResult, type SyncConfig } from '../src/wire.ts'

const stopHosts: Array<() => void> = []

afterEach(async () => {
  for (const stop of stopHosts.splice(0).reverse()) stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
  await cleanUp()
})

/** Mount the real host without a socket; status still runs its actual route. */
function timerHost(profileDir: string, credentials?: CredentialService) {
  type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>
  const routes = new Map<string, Handler>()
  const disposals: Array<() => void> = []
  const services: { credentials: CredentialService | undefined } = { credentials }
  const ctx = {
    get: (name: string) => name === 'credentials' ? services.credentials : undefined,
    webServer: {
      register(route: { path: string; handler: Handler }) {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    },
    inject(names: string[], callback: (context: unknown) => void) {
      if (names.includes('webServer')) callback(ctx)
    },
    effect(factory: () => unknown) {
      const dispose = factory()
      if (typeof dispose === 'function') disposals.push(dispose as () => void)
    },
  }
  stopHosts.push(() => { for (const dispose of disposals.reverse()) dispose() })
  apply(ctx as unknown as Context, { profileDir })
  return {
    services,
    async status(): Promise<StatusResult> {
      let response: StatusResult | undefined
      const res = {
        writeHead(code: number) { expect(code).toBe(200) },
        end(body: string) { response = JSON.parse(body) as StatusResult },
      }
      await routes.get(ROUTE_STATUS)!({ method: 'GET' } as IncomingMessage, res as unknown as ServerResponse)
      expect(response).toBeDefined()
      return response!
    },
  }
}

/** The first attempt is delayed 20s; subsequent ones use the saved interval. */
async function timerBed(over: Partial<SyncConfig> = {}, withCredentials = true, davOptions: FakeOptions = {}) {
  const paths = await writeProfile()
  const config = configFor({ autoEvery: 3, user: 'me', password: 'hunter2', ...over })
  await persistConfig(paths, config)
  const dav = new FakeDav(davOptions)
  dav.seedCollection('/dav/dsh-webdav')
  stopHosts.push(dav.use())
  const values = new Map([['FREE_API_KEY', 'first-key']])
  const credentials: CredentialService = {
    resolve: vi.fn(async (ref: string) => {
      const value = values.get(ref)
      return value === undefined ? undefined : { value, source: 'file' }
    }),
    set: vi.fn(async (ref: string, value: string) => { values.set(ref, value) }),
  }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(new Date('2026-10-21T06:00:00.000Z'))
  const sync = vi.spyOn(engines, 'sync')
  const host = timerHost(paths.profileDir, withCredentials ? credentials : undefined)
  const tick = async (milliseconds: number) => {
    const count = sync.mock.calls.length + 1
    await vi.advanceTimersByTimeAsync(milliseconds)
    // File reads before sync are real I/O, not timer callbacks. Wait for the
    // actual operation and its state write, rather than only draining promises.
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(count), { interval: 1 })
    await sync.mock.results[count - 1]!.value
  }
  const remote = async () => {
    const bytes = dav.files.get('/dav/dsh-webdav/dsh-profile.prop')?.data
    expect(bytes).toBeDefined()
    return await open(bytes!, config.passphrase) as Bundle
  }
  return { paths, config, dav, values, credentials, sync, host, tick, remote }
}

describe('the host automatic synchronization timer', () => {
  it('uploads managed keys on first and later ticks, and dates checks separately from actual syncs', async () => {
    const { dav, values, host, tick, remote } = await timerBed()
    await vi.advanceTimersByTimeAsync(19_999)
    expect(dav.calls).toEqual([])
    await tick(1)
    expect((await remote()).keys).toEqual({ refs: { FREE_API_KEY: 'first-key' } })
    const first = await host.status()
    expect(first.last).toBeDefined()
    expect(first.moved).toBe(first.last)
    expect(first.parts.find(part => part.part === 'keys')!.localChanged).toBe(false)
    const writes = dav.pathsFor('PUT').length

    await tick(3 * 60_000)
    const idle = await host.status()
    expect(Date.parse(idle.last!)).toBeGreaterThan(Date.parse(first.last!))
    expect(idle.moved).toBe(first.moved)
    expect(dav.pathsFor('PUT')).toHaveLength(writes)

    values.set('FREE_API_KEY', 'changed-key')
    expect((await host.status()).parts.find(part => part.part === 'keys')!.localChanged).toBe(true)
    await tick(3 * 60_000)
    expect((await remote()).keys).toEqual({ refs: { FREE_API_KEY: 'changed-key' } })
    const changed = await host.status()
    expect(Date.parse(changed.last!)).toBeGreaterThan(Date.parse(idle.last!))
    expect(changed.moved).toBe(changed.last)
    expect(changed.parts.find(part => part.part === 'keys')!.localChanged).toBe(false)
  })

  it('uses a session-only WebDAV password without writing it to disk', async () => {
    const { paths, dav, host, tick } = await timerBed({ rememberPassword: false })
    expect((await loadConfig(paths)).config.password).toBe('')
    expect(heldPassword(paths)).toBe('hunter2')
    await tick(20_000)
    expect(dav.pathsFor('PUT')).toHaveLength(1)
    expect(dav.calls.every(call => call.headers.authorization === `Basic ${Buffer.from('me:hunter2').toString('base64')}`)).toBe(true)
    expect((await host.status()).config.passwordSet).toBe(true)
    expect((await loadConfig(paths)).config.password).toBe('')
  })

  it('re-reads the credential service each tick instead of treating startup absence as permanent', async () => {
    const { host, tick, remote, credentials } = await timerBed({}, false)
    await tick(20_000)
    expect((await remote()).keys).toBeUndefined()
    const first = await host.status()
    expect(first.last).toBeDefined()
    await tick(3 * 60_000)
    const idle = await host.status()
    expect(Date.parse(idle.last!)).toBeGreaterThan(Date.parse(first.last!))
    expect(idle.moved).toBe(first.moved)

    host.services.credentials = credentials
    await tick(3 * 60_000)
    expect((await remote()).keys).toEqual({ refs: { FREE_API_KEY: 'first-key' } })
    expect((await host.status()).parts.find(part => part.part === 'keys')!.localChanged).toBe(false)
  })

  it('re-reads the saved interval and stops attempting when automatic sync is disabled', async () => {
    const { config, paths, host, tick, sync, dav } = await timerBed()
    await tick(20_000)
    await saveConfig(paths, { ...config, autoEvery: -1 })
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    // A status read after the timer proves the disk remains readable while no
    // new automatic operation should have been started.
    await host.status()
    expect(sync).toHaveBeenCalledTimes(1)
    expect(dav.pathsFor('PUT')).toHaveLength(1)
  })

  it('waits as long as a rate-limited server asked, instead of the ordinary interval', async () => {
    const { dav, sync, tick } = await timerBed({ autoEvery: 3 }, true, { rateLimit: { times: 1, retryAfter: '600' } })
    // A tick reads files, which is real I/O rather than a timer callback, so the
    // attempt it starts appears on the event loop after the fake clock moved.
    // `performance` is outside the faked set, so it measures real elapsed time.
    const settle = async (done: () => boolean, budget: number): Promise<void> => {
      const deadline = performance.now() + budget
      while (!done() && performance.now() < deadline) await new Promise(next => setImmediate(next))
    }

    await expect(tick(20_000)).rejects.toThrow(/限制了本机的访问频率/)
    expect(sync).toHaveBeenCalledTimes(1)

    // Three minutes is what the configuration would do; the server asked for ten.
    // Five minutes of clock with no second attempt is only possible if the hint
    // was read, and it is the difference between a pause and a lockout.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await settle(() => sync.mock.calls.length > 1, 300)
    expect(sync).toHaveBeenCalledTimes(1)

    for (let minute = 0; minute < 12 && sync.mock.calls.length === 1; minute += 1) {
      await vi.advanceTimersByTimeAsync(60_000)
      await settle(() => sync.mock.calls.length === 2, 1_000)
    }
    expect(sync).toHaveBeenCalledTimes(2)
    await sync.mock.results[1]!.value
    expect(dav.pathsFor('PUT')).toHaveLength(1)
  })
})

/** The configuration a profile starts with, on disk in a throwaway profile. */
async function bed(over: Partial<SyncConfig> = {}) {
  const paths = pathsOf(await tempDir())
  const engine = engineFor(
    paths,
    normaliseConfig({
      ...defaultConfig(),
      url: 'https://dav.test/dav',
      user: 'me',
      password: 'hunter2',
      passphrase: 'a passphrase',
      ...over,
    }),
  )
  const read = async (): Promise<SyncConfig> => (await loadConfig(paths)).config
  return { paths, engine, read }
}

describe('local forwarding in the sync configuration', () => {
  it('does not mint a relay account while forwarding is off', async () => {
    const { engine, read } = await bed()
    await configure(engine, { autoEvery: 15 })
    expect(await read()).toMatchObject({ relayEnabled: false, relayUser: '', relayPassword: '' })
  })

  it('mints an independent account once, and keeps it across saves, reloads and off/on', async () => {
    const { paths, engine, read } = await bed({ headers: 'X-Proxy: edge' })
    await configure(engine, { relayEnabled: true, relayPort: 4326 })
    const first = await read()
    const account = { relayUser: first.relayUser, relayPassword: first.relayPassword }
    expect(first).toMatchObject({
      url: 'https://dav.test/dav', user: 'me', password: 'hunter2',
      headers: 'X-Proxy: edge', relayEnabled: true, relayPort: 4326,
    })
    expect(first.relayUser).toMatch(/^dsh[0-9a-f]+$/)
    expect(first.relayPassword).toMatch(/^[0-9a-f]{32}$/)
    expect(first.relayUser).not.toBe(first.user)
    expect(first.relayPassword).not.toBe(first.password)
    expect(engine.config).toMatchObject(account)

    // Each route starts from disk, not the previous route's engine. A stable
    // in-memory pair alone would not keep clients signed in after a restart.
    const reloaded = engineFor(paths, first)
    await configure(reloaded, { autoEvery: 30 })
    expect(await read()).toMatchObject({ ...account, relayEnabled: true })
    await configure(reloaded, { relayEnabled: false })
    expect(await read()).toMatchObject({ ...account, relayEnabled: false })
    const reopened = engineFor(paths, await read())
    await configure(reopened, { relayEnabled: true })
    expect(await read()).toMatchObject({ ...account, relayEnabled: true, relayPort: 4326 })
    expect(reopened.config).toMatchObject(account)
  })

  it('does not let submitted relay credentials replace the generated account', async () => {
    const { engine, read } = await bed()
    await configure(engine, { relayEnabled: true })
    const first = await read()
    // These are deliberately extra keys, as could arrive from a hand-written
    // request. Only the switch and port belong to ConfigureBody.
    const body = { relayEnabled: true, relayUser: 'injected-user', relayPassword: 'injected-password' }
    await configure(engine, body)
    expect(await read()).toMatchObject({ relayUser: first.relayUser, relayPassword: first.relayPassword })
  })

  it.each([1, 65_535])('accepts relay port boundary %s', async (relayPort) => {
    const { engine, read } = await bed()
    await configure(engine, { relayPort })
    expect((await read()).relayPort).toBe(relayPort)
    expect(engine.config.relayPort).toBe(relayPort)
  })

  it.each([0, -1, 65_536, 3426.5, NaN, Infinity, -Infinity])(
    'refuses invalid relay port %s without changing the saved configuration',
    async (relayPort) => {
      const { engine, read } = await bed()
      await configure(engine, { relayPort: 4326 })
      const before = await read()
      await expect(configure(engine, { relayEnabled: true, relayPort })).rejects.toThrow(/转发端口.*1.*65535.*整数/)
      expect(await read()).toEqual(before)
      expect(engine.config).toEqual(before)
    },
  )

  it('forgets only the upstream password when remembering is turned off', async () => {
    const { paths, engine, read } = await bed()
    await configure(engine, { relayEnabled: true })
    const first = await read()
    const account = { relayUser: first.relayUser, relayPassword: first.relayPassword }
    await configure(engine, { rememberPassword: false })
    expect(await read()).toMatchObject({ ...account, password: '', rememberPassword: false, relayEnabled: true })
    expect(engine.config.password).toBe('hunter2')
    expect(engine.config).toMatchObject(account)
    expect(heldPassword(paths)).toBe('hunter2')
    await configure(engine, { relayEnabled: false })
    expect(await read()).toMatchObject({ ...account, password: '', relayEnabled: false })
    await configure(engine, { relayEnabled: true })
    expect(await read()).toMatchObject({ ...account, password: '', relayEnabled: true })
  })

  it('shows relay settings without exposing upstream secrets or its generated account in ConfigView', async () => {
    const { engine } = await bed()
    await configure(engine, { relayEnabled: true, relayPort: 4326 })
    const view = viewOf(engine.config)
    expect(view).toMatchObject({
      url: 'https://dav.test/dav', user: 'me', passwordSet: true, passphraseSet: true,
      relayEnabled: true, relayPort: 4326,
    })
    for (const key of ['password', 'passphrase', 'relayUser', 'relayPassword']) {
      expect(view).not.toHaveProperty(key)
    }
    const text = JSON.stringify(view)
    for (const secret of [engine.config.password, engine.config.passphrase, engine.config.relayPassword]) {
      expect(text).not.toContain(secret)
    }
  })
})

describe('configure', () => {
  it('keeps a stored password when the form is blank about it', async () => {
    const { engine, read } = await bed()
    await configure(engine, { autoEvery: 15 })
    expect((await read()).password).toBe('hunter2')
    expect(engine.config.password).toBe('hunter2')
  })

  it('takes a password the form actually sent', async () => {
    const { engine, read } = await bed()
    await configure(engine, { password: 'a new one' })
    expect((await read()).password).toBe('a new one')
  })

  it('drops the stored password when the address changes to another server', async () => {
    // A blank password field means "keep what is stored", which is only true
    // while the stored one belongs to the same account. Carrying it to another
    // server would post a credential for one service to a different one.
    const { engine, read } = await bed()
    await configure(engine, { url: 'https://other.test/dav' })
    const after = await read()
    expect(after.url).toBe('https://other.test/dav')
    expect(after.password).toBe('')
  })

  it('drops the stored password when the user changes on the same server', async () => {
    const { engine, read } = await bed()
    await configure(engine, { user: 'someone-else' })
    expect((await read()).password).toBe('')
  })

  it('keeps a password typed in the same submit that changes the address', async () => {
    // The new password was given for the new address, so it is not a carry-over
    // and must survive the rule above.
    const { engine, read } = await bed()
    await configure(engine, { url: 'https://other.test/dav', password: 'for the new one' })
    const after = await read()
    expect(after.url).toBe('https://other.test/dav')
    expect(after.password).toBe('for the new one')
  })

  it('does not treat a re-paste of the same address as an account change', async () => {
    // Only a trailing slash differs here, which normalisation is meant to absorb.
    const { engine, read } = await bed()
    await configure(engine, { url: 'https://dav.test/dav/' })
    expect((await read()).password).toBe('hunter2')
  })

  it('clears the password when rememberPassword is turned off', async () => {
    const { paths, engine, read } = await bed()
    await configure(engine, { rememberPassword: false })
    expect((await read()).password).toBe('')
    // Nothing on disk, but this run of the host still has to be able to sign in.
    expect(heldPassword(paths)).toBe('hunter2')
  })

  it('forgets the held password when it is remembered again', async () => {
    const { paths, engine } = await bed()
    await configure(engine, { rememberPassword: false })
    expect(heldPassword(paths)).toBe('hunter2')
    await configure(engine, { rememberPassword: true })
    expect(heldPassword(paths)).toBeUndefined()
  })

  it('refuses a passphrase equal to a password it is not writing down', async () => {
    // The password never reaches the disk, so the guard cannot read it from
    // there; the guard is about the password that will actually be sent.
    const { engine } = await bed()
    await configure(engine, { rememberPassword: false })
    await expect(configure(engine, { passphrase: 'hunter2' })).rejects.toThrow(/WebDAV 密码/)
  })

  it('refuses a passphrase equal to the WebDAV password', async () => {
    const { engine } = await bed()
    await expect(configure(engine, { passphrase: 'hunter2' })).rejects.toThrow(/WebDAV 密码/)
  })

  it('allows a passphrase when no password is in hand at all', async () => {
    // A new computer joining with a fresh passphrase: there is no WebDAV
    // password to be equal to, so the rule has nothing to say.
    const { engine, read } = await bed({ password: '' })
    await configure(engine, { passphrase: 'the new passphrase' })
    expect((await read()).passphrase).toBe('the new passphrase')
  })

  it('leaves the stored passphrase alone when the form is blank about it', async () => {
    const { engine, read } = await bed()
    await configure(engine, { url: 'https://other.test/dav' })
    expect((await read()).passphrase).toBe('a passphrase')
  })

  it('ignores an autoEvery that is not one of the offered intervals', async () => {
    const { engine, read } = await bed()
    await configure(engine, { autoEvery: 7 })
    expect((await read()).autoEvery).toBe(-1)
  })

  it('stores the configured headers, and can clear them with a blank', async () => {
    const { engine, read } = await bed()
    await configure(engine, { headers: 'Authorization: Bearer t\nX-Proxy: edge' })
    expect((await read()).headers).toBe('Authorization: Bearer t\nX-Proxy: edge')
    await configure(engine, { headers: '' })
    expect((await read()).headers).toBe('')
  })

  it('refuses a header line it cannot read, and keeps the stored one', async () => {
    // Refused at the form rather than at the next sync: the message can then
    // name the line while the user still has it in front of them.
    const { engine, read } = await bed()
    await configure(engine, { headers: 'X-Kept: 1' })
    await expect(configure(engine, { headers: 'X-A: 1\nnot a header' })).rejects.toThrow(/第 2 行/)
    expect((await read()).headers).toBe('X-Kept: 1')
    expect(engine.config.headers).toBe('X-Kept: 1')
  })

  it('stores the extra directories, and refuses one that is not absolute', async () => {
    const { engine, read } = await bed()
    const dir = await tempDir()
    await configure(engine, { dirs: [dir] })
    expect((await read()).dirs).toEqual([dir])

    // Refused at the form: a path that is not absolute here can never be read
    // or written on this computer, so storing it would only be a broken row.
    await expect(configure(engine, { dirs: ['notes/here'] })).rejects.toThrow(/绝对路径/)
    expect((await read()).dirs).toEqual([dir])
  })

  it('refuses more directories than it will carry', async () => {
    const { engine } = await bed()
    const root = await tempDir()
    const many = Array.from({ length: DIRS_MAX + 1 }, (_, index) => join(root, `n${index}`))
    await expect(configure(engine, { dirs: many })).rejects.toThrow(/最多同步/)
  })

  it('stores the switch that turns the extra directories off', async () => {
    const { engine, read } = await bed()
    await configure(engine, { dirsEnabled: false })
    expect((await read()).dirsEnabled).toBe(false)
    expect(engine.config.dirsEnabled).toBe(false)
    await configure(engine, { dirsEnabled: true })
    expect((await read()).dirsEnabled).toBe(true)
  })

  it('stores the switch that keeps this computer’s API keys behind', async () => {
    const { engine, read } = await bed()
    await configure(engine, { keys: false })
    expect((await read()).keys).toBe(false)
    expect(engine.config.keys).toBe(false)
    // A form that says nothing about it leaves the stored answer alone, the same
    // way every other part switch is read.
    await configure(engine, { autoEvery: 15 })
    expect((await read()).keys).toBe(false)
    await configure(engine, { keys: true })
    expect((await read()).keys).toBe(true)
  })
})
