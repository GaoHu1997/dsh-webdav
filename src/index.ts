/**
 * dsh-webdav-sync host half.
 *
 * The plugin's whole job is done by two halves that never both run in the same
 * process: this one, inside the DSH host, reads and writes the profile's own
 * files (`cordis.patch.yml` for the model catalog and the other rows,
 * `package.json` for the installed plugins), talks to the WebDAV server, and
 * serves the routes the browser half fetches; the browser half is a settings
 * card that shows what is where and asks for a sync.
 *
 * Nothing about the WebDAV account is stored in the composition: the profile
 * patch is itself one of the things that travels, so a password put there would
 * be uploaded by the next sync. It lives in the profile's
 * `.dsh-webdav-sync/sync.json`, mode 0600, beside the state and the cache.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { isAbsolute } from 'node:path'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: pulls the webServer Context declaration merge into this program.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the settings Context declaration merge (`ctx.settings`).
import type {} from '@deepseek-ai/dsh-settings'
import {
  AUTO_CHOICES,
  DIRS_MAX,
  ROUTE_CHECK,
  ROUTE_CONFIG,
  ROUTE_DISMISS,
  ROUTE_EXPORT,
  ROUTE_IMPORT,
  ROUTE_INSTALL,
  ROUTE_OFF,
  ROUTE_PREVIEW,
  ROUTE_RESTORE,
  ROUTE_STATUS,
  ROUTE_SYNC,
  ROUTE_UNDO,
  ROUTE_UPLOAD,
  type ConfigureBody,
  type DismissTarget,
  type ExportBody,
  type ImportBody,
} from './wire.js'
import { validateProfileDir, resolveFromEnv, type ResolvedPaths } from './paths.js'
import { RelayServer, makeRelayPassword, makeRelayUser } from './relay.js'
import {
  check,
  dismiss,
  engineFor,
  exportBackup,
  importBackup,
  loadConfig,
  preview,
  restore,
  sameAccount,
  status,
  sync,
  turnOff,
  undo,
  upload,
  usable,
  type Engine,
} from './engine.js'
import { installPlugins } from './install.js'
import { keysPort, type CredentialService, type KeysPort } from './keys.js'
import { sameSecret } from './crypto.js'
import { homeRelative, normaliseDirs } from './dirs.js'
import { parseHeaders, RateLimitedError } from './dav.js'
import { defaultConfig, ensureStateDir, heldPassword, normaliseConfig, persistConfig } from './state.js'

export const name = 'dsh-webdav-sync'

export const inject = []

/** Largest accepted request body (bytes) — these payloads are a few strings. */
const BODY_LIMIT = 64 * 1024

/**
 * Largest body the import route accepts: a whole sealed backup file, as text.
 *
 * The other routes carry a handful of form fields; this one carries a file, and a
 * backup that includes directories carries their files as base64 inside it. The
 * ceiling is the same 32 MiB the kept copies are bounded by, so a file this plugin
 * would have written is a file it will read back.
 */
const IMPORT_LIMIT = 32 * 1024 * 1024

/** How long the auto-sync timer waits before its first attempt. */
const FIRST_DELAY_MS = 20_000

function readVolatile<T>(value: Volatile<T> | T | undefined): T | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'object' && value !== null && 'get' in value && typeof (value as { get: unknown }).get === 'function') {
    return (value as Volatile<T>).get() as T
  }
  return value as T
}

export interface Config {
  /** Profile directory to sync; absent selects the running profile. */
  profileDir?: Volatile<string | undefined> | string
  /** How often the host syncs on its own, in minutes; `-1` (the default) is only when asked. */
  autoEvery?: Volatile<number> | number
}

/**
 * Cordis resolves the composition entry's config through this schema before
 * `apply` runs. In dsh 0.1.7+, fields marked with `.volatile()` are projected
 * by the settings service into live configuration forms.
 */
export const Config: z = z.object({
  profileDir: z.string().volatile(),
  autoEvery: z.number().default(-1).volatile(),
})

/** Reject stale or misspelled config keys before defaults can hide them. */
export function validateConfig(config: Config): void {
  const unknown = Object.keys(config).find(key => key !== 'profileDir' && key !== 'autoEvery')
  if (unknown !== undefined) {
    throw new Error(`WebdavSyncConfig：不认识的配置项「${unknown}」`)
  }
  const dir = readVolatile(config.profileDir)
  if (dir !== undefined && dir !== '') validateProfileDir(dir)
  const auto = readVolatile(config.autoEvery)
  if (auto !== undefined && !AUTO_CHOICES.includes(auto)) {
    throw new Error(`WebdavSyncConfig：「autoEvery」只能是 ${AUTO_CHOICES.join('、')} 之一`)
  }
}

/** An example of the shape the directory field wants, in this platform's spelling. */
function exampleDir(): string {
  return process.platform === 'win32' ? 'D:\\dsh-extra' : '/home/you/dsh-extra'
}

/**
 * Apply one configuration change from the card.
 *
 * A blank secret leaves the stored one alone rather than clearing it: the card
 * is given only whether a secret is set, so it can never send back what it was
 * never shown, and a form submitted without touching the password field must not
 * wipe it. The way to clear a stored password is to turn sync off.
 *
 * The passphrase is refused when it is the WebDAV password: the server is sent
 * the password, so a file sealed with it could be opened by whoever runs the
 * server, which is the opposite of what sealing it is for.
 */
export async function configure(engine: Engine, body: ConfigureBody): Promise<void> {
  const next = { ...engine.config }
  const gavePassword = typeof body.password === 'string' && body.password !== ''
  if (typeof body.url === 'string') next.url = body.url.trim().replace(/\/+$/, '')
  if (typeof body.user === 'string') next.user = body.user.trim()
  if (gavePassword) next.password = body.password as string
  if (typeof body.passphrase === 'string' && body.passphrase !== '') next.passphrase = body.passphrase
  if (typeof body.models === 'boolean') next.models = body.models
  if (typeof body.plugins === 'boolean') next.plugins = body.plugins
  if (typeof body.patch === 'boolean') next.patch = body.patch
  if (typeof body.keys === 'boolean') next.keys = body.keys
  if (typeof body.mcp === 'boolean') next.mcp = body.mcp
  if (typeof body.skills === 'boolean') next.skills = body.skills
  if (typeof body.rememberPassword === 'boolean') next.rememberPassword = body.rememberPassword
  if (typeof body.headers === 'string') {
    // Refused here rather than at the first request: the card can then show the
    // line it is unhappy about while the user is still looking at it.
    parseHeaders(body.headers)
    next.headers = body.headers
  }
  if (typeof body.autoEvery === 'number' && AUTO_CHOICES.includes(body.autoEvery)) {
    next.autoEvery = body.autoEvery
  }
  if (typeof body.dirsEnabled === 'boolean') next.dirsEnabled = body.dirsEnabled
  if (typeof body.relayEnabled === 'boolean') next.relayEnabled = body.relayEnabled
  if (typeof body.relayPort === 'number') {
    if (!Number.isInteger(body.relayPort) || body.relayPort < 1 || body.relayPort > 65_535) {
      throw new Error(`转发端口要填 1 到 65535 之间的整数：「${body.relayPort}」不是`)
    }
    next.relayPort = body.relayPort
  }
  // The account other programs sign in with, minted the first time the switch is
  // turned on. It is minted once and then left alone: it exists to be written
  // into those programs, and one that changed under them would be one they could
  // no longer sign in with — so turning the switch off and on again keeps the
  // same pair, as does any later save. A half-emptied pair (only reachable by
  // editing `sync.json` by hand) is completed rather than left unusable.
  if (next.relayEnabled && (next.relayUser === '' || next.relayPassword === '')) {
    next.relayUser = makeRelayUser()
    next.relayPassword = makeRelayPassword()
  }
  if (Array.isArray(body.dirs)) {
    // What the card sends is what was typed, one line per directory. What is
    // stored is one path each in a fixed order — the part is hashed whole, so two
    // computers that name the same set in a different order must still agree —
    // and a merely relative path is refused here, while the person is still
    // looking at the field, rather than left to fail as an unreadable directory
    // on every later sync. A `~`-prefixed one is not relative in that sense: it
    // travels as written and each computer resolves it against its own DSH home,
    // which is how a plugin's own data folder syncs between machines that name
    // their homes differently.
    next.dirs = normaliseDirs(body.dirs)
    const relative = next.dirs.find((path) => !isAbsolute(path) && !homeRelative(path))
    if (relative !== undefined) {
      throw new Error(`目录要填绝对路径，或以 ~ 开头按 DSH 主目录解析，像 ${exampleDir()} 这样：「${relative}」不是`)
    }
    // Five at most: each one is walked on every card open and carried whole on
    // every push, and a sixth would be a person pointing at a whole disk.
    if (next.dirs.length > DIRS_MAX) {
      throw new Error(`最多同步 ${DIRS_MAX} 个目录，现在填了 ${next.dirs.length} 个`)
    }
  }

  // The password this computer would actually send: one typed into this submit, or
  // the one already in hand for this account. What is written down is only part of
  // that — a password the user chose not to remember is held in memory for the run
  // — and this refusal is about the file on the server being openable by whoever
  // runs it, which is just as true of the one that would be sent. A changed
  // account has no password in hand at all: the carried one is dropped below, so
  // it cannot be what seals a file this submit is about to write.
  const inHand = gavePassword || sameAccount(engine.config, next)
  const sent = inHand ? (next.password !== '' ? next.password : (heldPassword(engine.paths) ?? '')) : ''
  if (next.passphrase !== '' && sent !== '' && sameSecret(next.passphrase, sent)) {
    throw new Error(
      '口令不能和 WebDAV 密码相同：密码是要发给服务器的，服务器可以拿它打开文件。请另设一个口令',
    )
  }
  // A blank password field means "keep the stored one", which is only a faithful
  // reading while the stored one belongs to the same account. Pointing this
  // computer at another server or user while carrying the old password along
  // would send a credential for one service to another, so the carried-over one
  // is dropped rather than reused. A password typed in this same submit is kept:
  // it was given for the address being saved. The card reads "a password is set"
  // from the stored value, so it stops saying so once this takes effect.
  if (!gavePassword && !sameAccount(engine.config, next)) next.password = ''
  // Turning remembering off is about the file, not about this run: the card says
  // the password "is used for this run only", and a password emptied here would
  // be one no request could ever carry, leaving sync unable to sign in until the
  // process restarts and the user retypes it. It stays in the engine — which is
  // what the running half talks to the server with — and is left out of what is
  // written down. That split lives in one place, {@link persistConfig}, because
  // this is no longer the only writer of the configuration.
  await persistConfig(engine.paths, next)
  engine.config = next
}

/**
 * The host's credential service, in the shape the sync uses it, or `undefined` on
 * a host that has none.
 *
 * A lookup rather than an injected dependency: a host without the service is a
 * working state — the `keys` part then reads nothing, writes nothing and says so —
 * and, like every other service here, it can come and go while the plugin is
 * mounted. `ctx.get` is the untyped accessor, so the shape is checked rather than
 * trusted from a type this plugin cannot import (it depends on no DSH package).
 */
function credentialPort(ctx: Context): KeysPort | undefined {
  const service = ctx.get('credentials') as Partial<CredentialService> | undefined
  if (service === undefined || typeof service.resolve !== 'function' || typeof service.set !== 'function') {
    return undefined
  }
  return keysPort(service as CredentialService)
}

/**
 * Plugin apply: mount the settings presentation policy, the HTTP routes and the
 * auto-sync timer on any webServer that comes and goes.
 *
 * Passwords that are in use but deliberately not on disk are read back here:
 * "remember the password" off means it must not be written to `sync.json`, and it
 * does not mean it should stop working. Every route rebuilds its engine from that
 * file, so a password emptied there would be one no request could carry and sync
 * would be unable to sign in until the process restarted. It is held for as long
 * as the host runs, keyed by the state directory so two profiles do not share
 * one, and put back into the configuration each time it is read.
 */
export function apply(ctx: Context, config: Config = {}): void {
  validateConfig(config)

  const currentConfig = (): Config => (ctx.fiber?.config as Config | undefined) ?? config

  /** Resolve the profile and read the stored sync configuration, always afresh. */
  const engine = async (): Promise<Engine> => {
    const paths: ResolvedPaths = resolveFromEnv(readVolatile(currentConfig().profileDir))
    const { config: stored } = await loadConfig(paths)
    const secret = stored.rememberPassword ? undefined : heldPassword(paths)
    const config = secret === undefined || secret === '' ? stored : { ...stored, password: secret }
    return engineFor(paths, config, credentialPort(ctx))
  }

  // In dsh 0.1.7+, the settings service projects volatile Config fields into
  // forms. auto: false tells the host this plugin ships its own card, which the
  // browser half registers as `plugins.bundle.config`.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(
      () => settingsCtx.settings.configure({ auto: false }, ctx.fiber),
      'webdav-sync: settings presentation policy',
    )
  })

  // The forwarder for other programs on this computer. It is a switch on the
  // configuration above rather than a second one, so it is handed that
  // configuration and nothing else: the address it forwards to, the account it
  // signs in with and the extra headers it adds are the ones the sync is already
  // set up with. What it adds is a door — an address on loopback, and an account
  // of its own, because the programs that come in by it hold that account and the
  // WebDAV password itself is never handed out to them.
  const relay = new RelayServer()
  let relayStopped = false
  void engine()
    .then((current) => relayStopped ? undefined : relay.apply(current.config, current.paths.stateDir))
    .catch(() => undefined)
  ctx.effect(
    () => () => {
      relayStopped = true
      void relay.stop()
    },
    'webdav-sync: relay forwarder',
  )

  ctx.inject(['webServer'], (webCtx) => {
    const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...headers,
      })
      res.end(JSON.stringify(body))
    }

    const readJson = (req: IncomingMessage, limit: number = BODY_LIMIT): Promise<Record<string, unknown>> =>
      new Promise((resolvePromise, rejectPromise) => {
        const chunks: Buffer[] = []
        let size = 0
        let tooLarge = false
        req.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > limit) {
            tooLarge = true
            chunks.length = 0
            return
          }
          if (!tooLarge) chunks.push(chunk)
        })
        req.on('end', () => {
          if (tooLarge) {
            rejectPromise(new Error('请求内容过大'))
            return
          }
          if (chunks.length === 0) {
            resolvePromise({})
            return
          }
          let parsed: unknown
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch (error) {
            rejectPromise(new Error(`请求内容不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`))
            return
          }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            rejectPromise(new Error('请求内容必须是 JSON 对象'))
            return
          }
          resolvePromise(parsed as Record<string, unknown>)
        })
        req.on('error', rejectPromise)
      })

    /**
     * One exact route. A failure answers 400 with its own message, which is what
     * the card shows: the messages this plugin raises are written to be read by
     * a person ("服务器上没有目录 … 请先在那边建好"), not to be mapped
     * onto status codes.
     */
    const route = (
      path: string,
      label: string,
      handle: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => Promise<void>,
      limit: number = BODY_LIMIT,
    ): void => {
      const method = path === ROUTE_STATUS ? 'GET' : 'POST'
      webCtx.effect(
        () =>
          webCtx.webServer.register({
            kind: 'exact',
            path,
            handler: async (req, res) => {
              if (req.method !== method) {
                req.resume()
                send(res, 405, { error: `此接口只接受 ${method} 请求` }, { Allow: method })
                return
              }
              try {
                await handle(req, res, method === 'GET' ? {} : await readJson(req, limit))
              } catch (error) {
                const text = error instanceof Error ? error.message : String(error)
                send(res, 400, { error: text })
              }
            },
          }),
        `webdav-sync: ${label} route`,
      )
    }

    route(ROUTE_STATUS, 'status', async (_req, res) => {
      const current = await engine()
      // The forwarder is a switch on this configuration, so this is where it is
      // brought in line with it: the card asks for this when it opens and every
      // fifteen seconds after, which is what makes a switch turned on in another
      // window, or a `sync.json` edited by hand, take effect.
      await relay.apply(current.config, current.paths.stateDir)
      send(res, 200, { ...(await status(current)), relay: relay.view() })
    })

    route(ROUTE_CONFIG, 'config', async (_req, res, body) => {
      const current = await engine()
      await configure(current, (body ?? {}) as ConfigureBody)
      await saveStateIfUsable(current)
      // Saved and applied in the same breath: the card reloads the status right
      // after this, and that read must not be the thing that makes the switch
      // real — a port the user cannot see the result of until later reads as one
      // that did not take.
      await relay.apply(current.config, current.paths.stateDir)
      send(res, 200, { message: '已保存' })
    })

    route(ROUTE_CHECK, 'check', async (_req, res) => {
      // An address that is not filled in is refused by `check` itself, in the one
      // sentence the card shows for it.
      send(res, 200, await check(await engine()))
    })

    route(ROUTE_SYNC, 'sync', async (req, res, body) => {
      const current = await engine()
      const force = (body as { force?: boolean } | undefined)?.force === true || new URL(req.url ?? '/', 'http://x').searchParams.get('force') === '1'
      send(res, 200, await sync(current, { force }))
    })

    route(ROUTE_PREVIEW, 'preview', async (_req, res) => {
      send(res, 200, await preview(await engine()))
    })

    route(ROUTE_RESTORE, 'restore', async (_req, res) => {
      send(res, 200, await restore(await engine()))
    })

    route(ROUTE_UNDO, 'undo', async (_req, res) => {
      send(res, 200, await undo(await engine()))
    })

    // The two manual-backup routes are the one pair that works with the filesystem
    // on this side of the wire. The card cannot save a file — the desktop shell
    // cancels browser downloads and exposes no save dialog — and cannot read one
    // either, so the export is written here and the import arrives as the file's
    // own text. See `docs/decisions/0060-manual-backup.md`.
    route(ROUTE_EXPORT, 'export', async (_req, res, body) => {
      for (const field of ['passphrase', 'dir']) {
        if (field in body && typeof body[field] !== 'string') throw new Error(`「${field}」必须是字符串`)
      }
      send(res, 200, await exportBackup(await engine(), body as ExportBody))
    })

    route(ROUTE_IMPORT, 'import', async (_req, res, body) => {
      for (const field of ['passphrase', 'text']) {
        if (field in body && typeof body[field] !== 'string') throw new Error(`「${field}」必须是字符串`)
      }
      send(res, 200, await importBackup(await engine(), body as ImportBody))
    }, IMPORT_LIMIT)

    route(ROUTE_UPLOAD, 'upload', async (_req, res) => {
      send(res, 200, await upload(await engine()))
    })

    route(ROUTE_DISMISS, 'dismiss', async (_req, res, body) => {
      // An empty body keeps the old meaning: put the sync notice away. A target
      // names the conditional prompt to hide, and its signature is what the
      // host matches later reads against — without it nothing is recorded.
      const target = typeof body.target === 'string' ? body.target : undefined
      if (target !== undefined && target !== 'pending-install' && target !== 'dir-problems' && target !== 'skill-problems' && target !== 'key-problems') {
        throw new Error('「target」不是可识别的提示种类')
      }
      const signature = typeof body.signature === 'string' ? body.signature : undefined
      await dismiss(await engine(), target as DismissTarget | undefined, signature)
      send(res, 200, { message: '已关闭提示' })
    })

    route(ROUTE_OFF, 'off', async (_req, res) => {
      await turnOff(await engine())
      const updated = await engine()
      await relay.apply(updated.config, updated.paths.stateDir)
      send(res, 200, { message: '已关闭 WebDAV 同步；服务器上的文件保持原样' })
    })

    route(ROUTE_INSTALL, 'install', async (_req, res) => {
      const current = await engine()
      send(res, 200, await installPlugins(current.paths))
    })
  })

  startTimer(ctx, engine)
}

/** Make sure the state directory exists, so the first sync has somewhere to write. */
async function saveStateIfUsable(engine: Engine): Promise<void> {
  try {
    await ensureStateDir(engine.paths)
  } catch {
    // Not being able to make the directory is reported by the first sync, which
    // needs it far more than a configuration change does.
  }
}

/**
 * Sync on a timer, when the stored configuration asks for it.
 *
 * The interval is read from the stored configuration before every attempt rather
 * than captured once, so changing it in the card takes effect without a reload.
 * A failure is recorded in the state by `sync` itself and the next tick tries
 * again, which is the whole point of a timer — except when the server asked for a
 * longer pause than the interval, which is honoured.
 */
function startTimer(ctx: Context, currentEngine: () => Promise<Engine>): void {
  let timer: NodeJS.Timeout | undefined
  let stopped = false

  const tick = async (): Promise<void> => {
    if (stopped) return
    let wait = 0
    try {
      // Use the same fresh engine as the routes: reading only sync.json would
      // drop both the host credential service and a session-only WebDAV password.
      const current = await currentEngine()
      const minutes = current.config.autoEvery
      if (usable(current.config) && minutes > 0) {
        wait = minutes * 60_000
        // A server that asked to be left alone gets what it asked for: the
        // retry hint is already a delay in milliseconds, and ignoring it is how
        // a rate limit turns into a lockout. The interval is the floor, so a
        // short hint never makes the timer busier than the configuration says.
        try {
          await sync(current)
        } catch (cause) {
          if (cause instanceof RateLimitedError && cause.after > 0) {
            wait = Math.max(cause.after, wait)
          }
        }
      }
    } catch {
      // A configuration that cannot be read yet is not an error worth logging on
      // every tick: the card is where it gets set.
    }
    if (stopped) return
    // Nothing to do is polled for slowly instead of not at all, so turning sync
    // on in the card starts it without a reload.
    timer = setTimeout(() => void tick(), wait === 0 ? 60_000 : wait)
    timer.unref?.()
  }

  timer = setTimeout(() => void tick(), FIRST_DELAY_MS)
  timer.unref?.()

  ctx.effect(
    () => () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    },
    'webdav-sync: auto-sync timer',
  )
}

export { defaultConfig, normaliseConfig, sameAccount, usable }
