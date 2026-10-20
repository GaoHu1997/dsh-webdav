/**
 * The host half's configuration writer.
 *
 * `configure` is where a card's form lands, and it is the only place that
 * decides what a blank secret field means. Every case here is about a value the
 * card cannot see and therefore cannot send back: what happens to a stored
 * password when the form says nothing about it, and when it says something about
 * the address instead.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { configure } from '../src/index.ts'
import { engineFor, pathsOf, viewOf } from '../src/engine.ts'
import { defaultConfig, heldPassword, loadConfig, normaliseConfig } from '../src/state.ts'
import { cleanUp, tempDir } from './harness.ts'
import { DIRS_MAX, type SyncConfig } from '../src/wire.ts'

afterEach(cleanUp)

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
})
