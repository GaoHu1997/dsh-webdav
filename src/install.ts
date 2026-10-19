/**
 * Installing the plugins a synced profile declares.
 *
 * A sync can bring in a `package.json` naming plugins this computer has never
 * installed. The profile's `node_modules` is not synced — it is a build product,
 * tens of megabytes of it — so the declaration travels and the packages are
 * fetched here instead.
 *
 * The command is `pnpm install` in the profile, which is what dsh's own plugin
 * manager runs; the packages come from the same registries, so nothing about
 * supply-chain rules changes because this plugin asked for them.
 *
 * The child's output goes to an open file, never a pipe. A pipe is a restricted
 * operation inside dsh's file sandbox, and this code runs wherever the harness
 * put the plugin: a file descriptor always works, and the tail of the file is
 * what the card shows anyway.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, open, readFile, rm, stat, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { InstallResult } from './wire.js'
import { installedPackages } from './engine.js'
import { missingPlugins } from './store.js'
import type { ResolvedPaths } from './paths.js'

/** How long an install may run before it is given up on. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

/** How much of the child's output the card is given. */
const TAIL_CHARS = 4000

/**
 * Where pnpm is, most authoritative first.
 *
 * dsh ships its own pnpm under `resources/runtime/pnpm`, and that is the version
 * the profile's lockfile was written by. `DSH_PNPM` lets a caller name one
 * outright; PATH is the last resort, since a machine with no global pnpm is
 * exactly the case this exists for.
 */
function pnpmCandidates(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = []
  const named = env.DSH_PNPM
  if (named !== undefined && named.trim() !== '') out.push(named.trim())
  const resources = env.DSH_RESOURCES_DIR
  if (resources !== undefined && resources.trim() !== '') {
    out.push(join(resources.trim(), 'runtime', 'pnpm', 'bin', 'pnpm.cjs'))
  }
  if (process.platform === 'win32') out.push('pnpm.cmd')
  else out.push('pnpm')
  return out
}

/** Whether a path names something that exists. */
async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

/**
 * Whether a path names something this computer can actually run.
 *
 * `exists` is not enough: a directory exists too, and so does a text file with no
 * interpreter. Spawning either one fails with an errno that differs by platform
 * and by kind of file — a directory is `EACCES` on Linux and `ENOENT` on Windows,
 * a text file is `EFTYPE` on Windows — and quoting that back would describe a
 * file the user never named instead of saying there is no pnpm here. So the
 * candidate is judged before it is spawned, and the answer is the same on every
 * computer.
 */
async function runnable(file: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false
  } catch {
    return false
  }
  if (process.platform === 'win32') {
    // Windows starts a program by its extension; anything else is opened by an
    // application, which is not what `spawn` does.
    const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((part) => part.trim() !== '')
    return extensions.some((extension) => file.toLowerCase().endsWith(extension.trim().toLowerCase()))
  }
  try {
    // A file this computer is not allowed to execute is not a pnpm either. The
    // bundled `pnpm.cjs` dsh ships is executable, so it still qualifies.
    await access(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Whether a failed spawn means "this computer cannot start that", rather than
 * something that went wrong while running it.
 *
 * The errno differs by platform and by what the path turned out to be: `ENOENT`
 * for a target that is not there (and for a directory on Windows), `EACCES` for
 * one that exists without the right to execute it (a directory on Linux),
 * `ENOEXEC` for a file whose interpreter cannot be started, `EFTYPE` for a file
 * Windows refuses to start, `ENOTDIR` for a path with a non-directory in the
 * middle. Every one of them means the same thing to the user — there is no pnpm
 * here — and none of them is worth quoting.
 */
const NOT_A_COMMAND = new Set(['ENOENT', 'EACCES', 'ENOEXEC', 'EFTYPE', 'ENOTDIR'])

/**
 * Whether a bare command name is one this computer can run.
 *
 * A name with no separator in it is handed to the shell, and a shell that
 * cannot find it still starts and still answers — with its own complaint, in
 * its own words ("'pnpm.cmd' is not recognized…"). Searching PATH here first
 * keeps that from happening, so "there is no pnpm" arrives as the sentence
 * written for it rather than as whatever the shell says.
 */
async function onPath(name: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const path = env.PATH ?? env.Path ?? ''
  const windows = process.platform === 'win32'
  const base = windows ? name.replace(/\.(cmd|exe|bat|com)$/i, '') : name
  const extensions = windows
    ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((part) => part.trim() !== '')]
    : ['']
  for (const directory of path.split(windows ? ';' : ':')) {
    if (directory.trim() === '') continue
    for (const extension of extensions) {
      if (await exists(join(directory, base + extension))) return true
      if (await exists(join(directory, name))) return true
    }
  }
  return false
}

/** Whether a failed spawn means the command could not be started at all. */
function missingCommand(cause: unknown): boolean {
  const code = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined
  return typeof code === 'string' && NOT_A_COMMAND.has(code)
}

/** The last `chars` characters of a text, with a marker when it was cut. */
function tail(text: string, chars: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= chars) return trimmed
  return `…${trimmed.slice(trimmed.length - chars)}`
}

/**
 * Run `pnpm install` in the profile directory.
 *
 * A nonzero exit is not a thrown error: the card shows what pnpm said, which is
 * the only thing that tells a user whether a package name was wrong or the
 * network was down. A pnpm that cannot be started at all is the one case that
 * throws, because there is nothing to show.
 */
export async function installPlugins(paths: ResolvedPaths): Promise<InstallResult> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-webdav-install-'))
  const logFile = join(dir, 'pnpm.log')
  const env: NodeJS.ProcessEnv = { ...process.env, CI: '1' }
  delete env.npm_config_prefix

  let output = ''
  let code: number | null = null
  let started = false
  let lastCause: unknown

  try {
    for (const candidate of pnpmCandidates(process.env)) {
      if (candidate.includes('\\') || candidate.includes('/')) {
        if (!(await runnable(candidate, process.env))) continue
      } else if (!(await onPath(candidate, process.env))) {
        continue
      }
      try {
        code = await run(candidate, ['install', '--reporter', 'append-only'], paths.profileDir, env, logFile)
        started = true
        lastCause = undefined
        break
      } catch (cause) {
        // A command that is not there is not a failure worth quoting back: the
        // shell's own words for it name a file the user never asked for. Let it
        // fall through to the sentence below, which says what to do about it.
        // The candidate check above is what normally keeps this from happening;
        // this is the second line of defence for a file that exists and still
        // cannot be started (a broken interpreter, a path that changed underneath
        // us).
        if (!missingCommand(cause)) lastCause = cause
      }
    }
    output = tail(await readFile(logFile, 'utf8').catch(() => ''), TAIL_CHARS)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }

  if (!started) {
    if (lastCause !== undefined) {
      const why = lastCause instanceof Error ? lastCause.message : String(lastCause)
      throw new Error(`在 ${paths.profileDir} 里运行 pnpm 失败：${why}`)
    }
    throw new Error(
      '这台电脑上没有 pnpm，同步带过来的插件就装不上：请先安装 pnpm，或者把 DSH_PNPM 指向 pnpm 可执行文件',
    )
  }

  const still = await stillMissing(paths)
  if (code !== 0 && still.length > 0) {
    return { ok: false, output: output === '' ? `pnpm 的退出码是 ${code}` : output }
  }
  if (still.length > 0) {
    return { ok: false, output: `pnpm 跑完了，但这些仍然没有装上：${still.join('、')}` }
  }
  return { ok: true, output: output === '' ? 'pnpm 跑完了，没有输出' : output }
}

/** The plugins the profile declares that are still not in `node_modules`. */
async function stillMissing(paths: ResolvedPaths): Promise<string[]> {
  const raw = await readFile(paths.packageFile, 'utf8').catch(() => '{}')
  let manifest: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') manifest = parsed as Record<string, unknown>
  } catch {
    // An unreadable manifest is not this function's to report: the declaring
    // side already reads it, and an empty declaration simply says "nothing".
  }
  const deps = manifest.dependencies
  const profile = (manifest.dsh as Record<string, unknown> | undefined)?.profile
  const bundles = (profile as Record<string, unknown> | undefined)?.bundles
  const declared = {
    dependencies: deps !== null && typeof deps === 'object' ? (deps as Record<string, string>) : {},
    bundles: Array.isArray(bundles) ? bundles.filter((item): item is string => typeof item === 'string') : [],
  }
  return missingPlugins(declared, await installedPackages(paths))
}

/** Spawn one command with its output going to a file, and answer its exit code. */
async function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  logFile: string,
): Promise<number> {
  const handle = await open(logFile, 'a')
  try {
    return await new Promise<number>((resolvePromise, rejectPromise) => {
      const child = spawn(command, args, {
        cwd,
        env,
        // The output goes to an open file descriptor rather than a pipe: a pipe
        // is refused inside dsh's file sandbox, and there is nothing here that
        // needs it — the tail of the file is what is shown.
        stdio: ['ignore', handle.fd, handle.fd],
        windowsHide: true,
        shell: command.endsWith('.cmd'),
      })

      const timer = setTimeout(() => {
        child.kill()
        rejectPromise(new Error(`pnpm 在 ${INSTALL_TIMEOUT_MS / 60000} 分钟内没有跑完`))
      }, INSTALL_TIMEOUT_MS)

      child.on('error', cause => {
        clearTimeout(timer)
        rejectPromise(cause)
      })
      child.on('close', exitCode => {
        clearTimeout(timer)
        resolvePromise(exitCode ?? 1)
      })
    })
  } finally {
    await handle.close().catch(() => undefined)
  }
}
