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
import { engineFor, pathsOf } from '../src/engine.ts'
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
