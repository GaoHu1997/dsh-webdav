/**
 * The plugin's own files inside a profile.
 *
 * Everything here is about the two things a sync is allowed to keep between
 * runs: the configuration (which holds a password) and the hashes that make a
 * three-way merge possible. The state key matters most — change the address,
 * the account or the passphrase and the stored hashes no longer describe the
 * file being synced, so they must not be used as a baseline.
 */

import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CACHE_NAME,
  CONFIG_NAME,
  STATE_NAME,
  cached,
  configFile,
  defaultConfig,
  ensureStateDir,
  keptDir,
  loadConfig,
  loadState,
  normaliseConfig,
  normaliseUrl,
  remember,
  sameAccount,
  saveConfig,
  saveState,
  stateFile,
  stateKey,
  syncsPart,
  usable,
} from '../src/state.ts'
import { AUTO_MANUAL, RELAY_DEFAULT_PORT, type SyncConfig } from '../src/wire.ts'
import { pathsOf } from '../src/engine.ts'
import { cleanUp, tempDir } from './harness.ts'

afterEach(cleanUp)

const BASE: SyncConfig = { ...defaultConfig(), url: 'https://dav.test/dav', passphrase: 'a passphrase' }

describe('defaultConfig', () => {
  it('starts off, with every part on and no address', () => {
    const config = defaultConfig()
    expect(config.url).toBe('')
    expect(config.user).toBe('')
    expect(config.password).toBe('')
    expect(config.passphrase).toBe('')
    expect(config.headers).toBe('')
    expect(config.dirs).toEqual([])
    expect(config.dirsEnabled).toBe(true)
    expect(config.autoEvery).toBe(AUTO_MANUAL)
    expect(config.rememberPassword).toBe(true)
    expect(config.relayEnabled).toBe(false)
    expect(config.relayPort).toBe(RELAY_DEFAULT_PORT)
    expect(config.relayUser).toBe('')
    expect(config.relayPassword).toBe('')
    // Nothing is off until somebody turns it off: a first run copies everything.
    expect([config.models, config.defaults, config.plugins, config.patch]).toEqual([true, true, true, true])
  })
})

describe('normaliseConfig', () => {
  it('fills in what a stored file is missing', () => {
    const config = normaliseConfig({ url: '  https://dav.test/dav  ' })
    expect(config.url).toBe('  https://dav.test/dav  ')
    expect(config.autoEvery).toBe(AUTO_MANUAL)
    expect(config.models).toBe(true)
  })

  it('keeps only an interval the plugin actually offers', () => {
    expect(normaliseConfig({ autoEvery: 30 }).autoEvery).toBe(30)
    // A number the card could never have produced is ignored, not obeyed.
    expect(normaliseConfig({ autoEvery: 7 }).autoEvery).toBe(AUTO_MANUAL)
    expect(normaliseConfig({ autoEvery: '30' }).autoEvery).toBe(AUTO_MANUAL)
    expect(normaliseConfig({ autoEvery: 1.5 }).autoEvery).toBe(AUTO_MANUAL)
  })

  it('ignores a value of the wrong type rather than trusting it', () => {
    const config = normaliseConfig({ url: 42, models: 'yes', rememberPassword: 0 })
    expect(config.url).toBe('')
    expect(config.models).toBe(true)
    expect(config.rememberPassword).toBe(true)
  })

  it('takes a part switch that was really turned off', () => {
    expect(normaliseConfig({ models: false }).models).toBe(false)
  })

  it('takes the switch that turns the extra directories off, and only a real one', () => {
    expect(normaliseConfig({ dirsEnabled: false }).dirsEnabled).toBe(false)
    expect(normaliseConfig({ dirsEnabled: 'no' }).dirsEnabled).toBe(true)
    // A file written before the switch existed has no such key, and the part was
    // on there: an absent switch reads as on.
    expect(normaliseConfig({}).dirsEnabled).toBe(true)
  })

  it('keeps the relay switch and independent account only when their types match', () => {
    expect(normaliseConfig({ relayEnabled: true, relayPort: 4326, relayUser: 'local-user', relayPassword: 'local-password' }))
      .toMatchObject({ relayEnabled: true, relayPort: 4326, relayUser: 'local-user', relayPassword: 'local-password' })
    expect(normaliseConfig({ relayEnabled: 'yes', relayUser: 42, relayPassword: false }))
      .toMatchObject({ relayEnabled: false, relayUser: '', relayPassword: '' })
  })

  it.each([1, 4326, 65_535])('keeps valid stored relay port %s', (relayPort) => {
    expect(normaliseConfig({ relayPort }).relayPort).toBe(relayPort)
  })

  it.each([0, -1, 65_536, 3426.5, NaN, Infinity, '4326', null])(
    'falls back to the default for invalid stored relay port %s',
    (relayPort) => {
      expect(normaliseConfig({ relayPort }).relayPort).toBe(RELAY_DEFAULT_PORT)
    },
  )

  it('keeps the configured headers as typed, and drops anything that is not text', () => {
    // The lines are parsed where they are used, so what is stored is exactly
    // what the card will show again; blanking it is a real value, not a gap.
    expect(normaliseConfig({ headers: 'X-A: 1\nX-B: 2' }).headers).toBe('X-A: 1\nX-B: 2')
    expect(normaliseConfig({ headers: 42 }).headers).toBe('')
    expect(normaliseConfig({}).headers).toBe('')
  })
})

describe('stateKey', () => {
  it('differs for a different address, account or passphrase', () => {
    const base = stateKey(BASE)
    expect(stateKey({ ...BASE, url: 'https://other.test/dav' })).not.toBe(base)
    expect(stateKey({ ...BASE, user: 'someone' })).not.toBe(base)
    expect(stateKey({ ...BASE, passphrase: 'another' })).not.toBe(base)
  })

  it('is the same however the address was typed', () => {
    // Trailing slashes are the same folder, so a stored state must not be
    // thrown away because somebody re-typed the address with a slash.
    expect(stateKey({ ...BASE, url: 'https://dav.test/dav/' })).toBe(stateKey(BASE))
    expect(stateKey({ ...BASE, url: ' https://dav.test/dav ' })).toBe(stateKey(BASE))
  })

  it('does not change when only the switches change', () => {
    expect(stateKey({ ...BASE, models: false, autoEvery: 60 })).toBe(stateKey(BASE))
  })

  it('does not change when only the request headers change', () => {
    // Headers are how this computer reaches the same account, not which account
    // it is: the state that remembers what both sides last held still applies.
    expect(stateKey({ ...BASE, headers: 'X-A: 1' })).toBe(stateKey(BASE))
  })
})

describe('sameAccount', () => {
  it('is true for the same server and user', () => {
    expect(sameAccount(BASE, { ...BASE, password: 'other' })).toBe(true)
  })

  it('is false for a different server or user', () => {
    // A saved password is only ever sent to the server and user it was given
    // for, so this is what stops it leaking to a new address.
    expect(sameAccount(BASE, { ...BASE, url: 'https://other.test/dav' })).toBe(false)
    expect(sameAccount(BASE, { ...BASE, user: 'someone' })).toBe(false)
  })
})

describe('usable', () => {
  it('needs both an address and a passphrase', () => {
    expect(usable(BASE)).toBe(true)
    expect(usable({ ...BASE, url: '' })).toBe(false)
    expect(usable({ ...BASE, passphrase: '' })).toBe(false)
    expect(usable({ ...BASE, passphrase: '   ' })).toBe(false)
  })
})

describe('syncsPart', () => {
  it('reports each part on its own switch', () => {
    const config: SyncConfig = { ...BASE, models: false, patch: false }
    expect(syncsPart(config, 'models')).toBe(false)
    expect(syncsPart(config, 'patch')).toBe(false)
    expect(syncsPart(config, 'defaults')).toBe(true)
    expect(syncsPart(config, 'plugins')).toBe(true)
  })
})

describe('normaliseUrl', () => {
  it('trims and drops trailing slashes', () => {
    expect(normaliseUrl('  https://dav.test/dav//  ')).toBe('https://dav.test/dav')
  })
})

describe('the files on disk', () => {
  it('names them under the profile', async () => {
    const dir = await tempDir()
    const paths = pathsOf(dir)
    expect(paths.stateDir).toBe(join(dir, '.dsh-webdav-sync'))
    expect(configFile(paths)).toBe(join(paths.stateDir, CONFIG_NAME))
    expect(stateFile(paths)).toBe(join(paths.stateDir, STATE_NAME))
    expect(keptDir(paths)).toBe(join(paths.stateDir, 'sync'))
  })

  it('reads a configuration that is not there as the default', async () => {
    const paths = pathsOf(await tempDir())
    const { config, found } = await loadConfig(paths)
    expect(found).toBe(false)
    expect(config.autoEvery).toBe(AUTO_MANUAL)
  })

  it('loads an older sync.json without enabling forwarding or losing its upstream configuration', async () => {
    const paths = pathsOf(await tempDir())
    const legacy = {
      url: 'https://dav.test/dav', user: 'me', password: 'upstream-password',
      passphrase: 'a passphrase', headers: 'X-Proxy: edge', autoEvery: 15,
      models: false, defaults: true, plugins: true, patch: false,
      dirs: [], dirsEnabled: false, rememberPassword: true,
    }
    await ensureStateDir(paths)
    await writeFile(configFile(paths), JSON.stringify(legacy), 'utf8')
    expect(await loadConfig(paths)).toEqual({
      found: true,
      config: {
        ...legacy, relayEnabled: false, relayPort: RELAY_DEFAULT_PORT, relayUser: '', relayPassword: '',
      },
    })
    // Reading is compatibility, not a migration write: the old file stays put.
    expect(JSON.parse(await readFile(configFile(paths), 'utf8'))).toEqual(legacy)
  })

  it('round-trips the independent relay account in the same configuration file', async () => {
    const paths = pathsOf(await tempDir())
    const config = {
      ...BASE, relayEnabled: true, relayPort: 4326, relayUser: 'local-user', relayPassword: 'local-password',
    }
    await saveConfig(paths, config)
    expect(await loadConfig(paths)).toEqual({ config, found: true })
  })

  it('reads a state that is not there as empty', async () => {
    const paths = pathsOf(await tempDir())
    expect(await loadState(paths)).toEqual({})
  })

  it('round-trips the configuration, and keeps it private', async () => {
    const paths = pathsOf(await tempDir())
    await saveConfig(paths, { ...BASE, user: 'me', password: 'hunter2', autoEvery: 15 })
    const { config, found } = await loadConfig(paths)
    expect(found).toBe(true)
    expect(config.user).toBe('me')
    expect(config.password).toBe('hunter2')
    expect(config.autoEvery).toBe(15)
    // The file holds a password, so nobody else on the machine may read it.
    // Windows cannot clear the read bits through chmod, so the mode is only
    // asserted where the platform can express it.
    if (process.platform !== 'win32') {
      expect((await stat(configFile(paths))).mode & 0o777).toBe(0o600)
    }
  })

  it('round-trips the state, and keeps it private', async () => {
    const paths = pathsOf(await tempDir())
    await saveState(paths, {
      key: 'k',
      sum: 's',
      server: { etag: '"v1"' },
      local: { models: 'a' },
      remote: { models: 'b' },
      last: '2026-01-01T00:00:00.000Z',
      notice: { at: '2026-01-01T00:00:00.000Z', here: ['models'], there: [] },
    })
    const state = await loadState(paths)
    expect(state.key).toBe('k')
    expect(state.server?.etag).toBe('"v1"')
    expect(state.local).toEqual({ models: 'a' })
    expect(state.remote).toEqual({ models: 'b' })
    expect(state.notice?.here).toEqual(['models'])
    if (process.platform !== 'win32') {
      expect((await stat(stateFile(paths))).mode & 0o777).toBe(0o600)
    }
  })

  it('says a damaged file is damaged rather than treating it as none', async () => {
    const paths = pathsOf(await tempDir())
    await ensureStateDir(paths)
    await writeFile(stateFile(paths), 'not json at all', 'utf8')
    // Only being absent means "there is none here". A file that cannot be read
    // is a different thing, and it is named: a state read as empty would say
    // this computer had never synced, and the server's copy would be taken over
    // it without a word.
    await expect(loadState(paths)).rejects.toThrow(new RegExp(`${STATE_NAME.replace('.', '\\.')} 不是可读的 JSON`))
    await writeFile(configFile(paths), '[]', 'utf8')
    // An array is not a configuration either, and it is there.
    await expect(loadConfig(paths)).rejects.toThrow(new RegExp(`${CONFIG_NAME.replace('.', '\\.')} 里不是 JSON 对象`))
    // Absent is still absence, and it is not an error.
    await rm(stateFile(paths))
    expect(await loadState(paths)).toEqual({})
    await rm(configFile(paths))
    expect(await loadConfig(paths)).toEqual({ config: defaultConfig(), found: false })
  })

  it('writes plain readable JSON', async () => {
    const paths = pathsOf(await tempDir())
    await saveConfig(paths, BASE)
    const text = await readFile(configFile(paths), 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text).url).toBe('https://dav.test/dav')
  })

  it('makes the directory when it is missing', async () => {
    const paths = pathsOf(await tempDir())
    await ensureStateDir(paths)
    await ensureStateDir(paths)
    expect((await stat(paths.stateDir)).isDirectory()).toBe(true)
  })
})

describe('the cached copy of the server file', () => {
  it('keeps the bytes and hands them back only for the sum they were stored under', async () => {
    const paths = pathsOf(await tempDir())
    const data = new TextEncoder().encode('sealed bytes')
    await remember(paths, data)
    expect(await readFile(join(paths.stateDir, CACHE_NAME))).toEqual(Buffer.from(data))
    // The cache is what lets a sync merge against what the server last held
    // without downloading it again, so it must answer for its own sum only.
    const { sum } = await import('../src/crypto.ts')
    expect(await cached(paths, sum(data))).toEqual(data)
    expect(await cached(paths, 'not-the-sum')).toBeUndefined()
  })

  it('answers nothing when there is no cache at all', async () => {
    const paths = pathsOf(await tempDir())
    expect(await cached(paths, 'anything')).toBeUndefined()
  })
})
