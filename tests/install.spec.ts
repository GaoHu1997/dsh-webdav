/**
 * Installing the plugins a synced profile declares.
 *
 * This is the plugin's only code path that starts a child process, and the
 * interesting part is not pnpm itself but which command it decides to run: the
 * candidate list is searched before anything is spawned, so a computer with no
 * pnpm gets the sentence written for it instead of the shell's own complaint
 * about a file nobody asked for.
 *
 * The stand-in pnpm writes to stdout, which must reach the card through the
 * log file the child's descriptor points at — a pipe would be refused inside
 * dsh's file sandbox, so this is also the check that the write end is a file.
 */

import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installPlugins } from '../src/install.ts'
import type { ResolvedPaths } from '../src/paths.ts'
import { cleanUp, tempDir } from './harness.ts'

/** Environment keys the test drives, restored after each case. */
const KEYS = ['DSH_PNPM', 'DSH_RESOURCES_DIR', 'PATH', 'Path', 'PATHEXT'] as const
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = {}
  for (const key of KEYS) saved[key] = process.env[key]
})

afterEach(async () => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  await cleanUp()
})

/** A profile declaring two plugins, with an empty `node_modules`. */
async function profile(): Promise<ResolvedPaths> {
  const dir = await tempDir('dsh-webdav-install-')
  await writeFile(
    join(dir, 'package.json'),
    `${JSON.stringify({
      name: 'install-probe',
      private: true,
      dependencies: { 'billion-context': '0.1.197', 'dsh-git-branch-manage': '^1.0.2' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }, null, 2)}\n`,
    'utf8',
  )
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  return {
    profileDir: dir,
    stateDir: join(dir, '.dsh-webdav-sync'),
    patchFile: join(dir, 'cordis.patch.yml'),
    packageFile: join(dir, 'package.json'),
    baseFile: join(dir, 'cordis.yml'),
  }
}

/** A `pnpm` that writes a line, optionally makes the packages, and exits. */
async function standin(options: { exit?: number; install?: boolean; line?: string }): Promise<string> {
  const { exit = 0, install = false, line = 'pnpm: stand-in ran' } = options
  const dir = await mkdtemp(join(tmpdir(), 'dsh-webdav-pnpm-'))
  const script = join(dir, 'stand-in.cjs')
  await writeFile(
    script,
    [
      `process.stdout.write(${JSON.stringify(`${line}\n`)})`,
      `process.stderr.write('pnpm: stand-in on stderr\\n')`,
      install
        ? `for (const name of ['billion-context', 'dsh-git-branch-manage']) require('node:fs').mkdirSync(require('node:path').join(process.cwd(), 'node_modules', name), { recursive: true })`
        : '',
      `process.exit(${exit})`,
    ].join('\n'),
    'utf8',
  )
  // A `.cmd` shim is what a bare name resolves to on Windows; elsewhere the
  // file itself is the executable.
  if (process.platform === 'win32') {
    const cmd = join(dir, 'stand-in.cmd')
    await writeFile(cmd, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8')
    return cmd
  }
  const sh = join(dir, 'stand-in')
  await writeFile(sh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { encoding: 'utf8', mode: 0o755 })
  return sh
}

/** Take every pnpm away: no `DSH_PNPM`, no bundled one, an empty PATH. */
async function withoutPnpm(): Promise<void> {
  delete process.env.DSH_PNPM
  delete process.env.DSH_RESOURCES_DIR
  process.env.PATH = await tempDir('dsh-webdav-no-path-')
  delete process.env.Path
}

describe('installPlugins', () => {
  it('reports what the child wrote, and says nothing is missing when it installed', async () => {
    const paths = await profile()
    process.env.DSH_PNPM = await standin({ exit: 0, install: true, line: 'pnpm: installed both' })
    const result = await installPlugins(paths)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('installed both')
    expect(result.output).not.toContain('still not installed')
  }, 60_000)

  it('names the packages a pnpm that exited cleanly left behind', async () => {
    const paths = await profile()
    process.env.DSH_PNPM = await standin({ exit: 0, line: 'pnpm: nothing to do' })
    const result = await installPlugins(paths)
    expect(result.ok).toBe(false)
    expect(result.output).toContain('billion-context')
    expect(result.output).toContain('dsh-git-branch-manage')
  }, 60_000)

  it('shows pnpm\'s own words when it failed and things are still missing', async () => {
    const paths = await profile()
    process.env.DSH_PNPM = await standin({ exit: 7, line: 'pnpm: the registry refused us' })
    const result = await installPlugins(paths)
    expect(result.ok).toBe(false)
    expect(result.output).toContain('the registry refused us')
  }, 60_000)

  it('does not call a nonzero exit a failure when nothing is missing', async () => {
    // The exit code is not the verdict: a `postinstall` that failed after the
    // packages landed must not leave the card red.
    const paths = await profile()
    process.env.DSH_PNPM = await standin({ exit: 9, install: true, line: 'pnpm: postinstall failed' })
    expect((await installPlugins(paths)).ok).toBe(true)
  }, 60_000)

  it('says how to give it a pnpm when the machine has none', async () => {
    const paths = await profile()
    await withoutPnpm()
    await expect(installPlugins(paths)).rejects.toThrow(
      /这台电脑上没有 pnpm.*DSH_PNPM/s,
    )
  })

  it('says the same thing when DSH_PNPM names a file that is not really there', async () => {
    // A path that exists but cannot be run (a directory, or a file with no
    // interpreter) must land on the same advice rather than quoting the shell.
    const paths = await profile()
    await withoutPnpm()
    process.env.DSH_PNPM = await tempDir('dsh-webdav-not-a-pnpm-')
    await expect(installPlugins(paths)).rejects.toThrow(/这台电脑上没有 pnpm/)
  })

  it('says the same thing when DSH_PNPM names a file no interpreter can run', async () => {
    // Existence is not the question: a text file exists and is still not a pnpm.
    // Linux finds no execute bit on it, Windows finds an extension it will not
    // start — either way the candidate is passed over before anything is spawned,
    // so the answer does not depend on which computer asked.
    const paths = await profile()
    await withoutPnpm()
    const dir = await tempDir('dsh-webdav-not-a-program-')
    const file = join(dir, 'pnpm-notes.txt')
    await writeFile(file, 'not a program\n', { encoding: 'utf8' })
    await chmod(file, 0o644)
    process.env.DSH_PNPM = file
    await expect(installPlugins(paths)).rejects.toThrow(/这台电脑上没有 pnpm/)
  })

  it('starts a pnpm whose path has a space in it', async () => {
    // cmd.exe rejoins the words itself, so an unquoted `C:\Program Files\...`
    // arrives as `C:\Program` — the install fails while this plugin reports
    // pnpm's complaint instead of naming the path it was given.
    const paths = await profile()
    const shim = await standin({ exit: 0, install: true, line: 'pnpm: under a space' })
    const spaced = join(await tempDir('dsh-webdav-spaced-'), 'Program Files', 'nodejs')
    await mkdir(spaced, { recursive: true })
    const moved = join(spaced, basename(shim))
    await rename(shim, moved)
    if (process.platform !== 'win32') {
      await chmod(moved, 0o755)
    }
    process.env.DSH_PNPM = moved
    const result = await installPlugins(paths)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('under a space')
  }, 60_000)

  it('runs the pnpm dsh ships, which is a script and has no .cmd beside it', async () => {
    // dsh installs `resources/runtime/pnpm/bin/pnpm.cjs` on every platform. It is
    // a script, so Windows' PATHEXT would refuse it and the machine would be told
    // it has no pnpm at all.
    const paths = await profile()
    await withoutPnpm()
    const resources = await tempDir('dsh-webdav-resources-')
    const bin = join(resources, 'runtime', 'pnpm', 'bin')
    await mkdir(bin, { recursive: true })
    const script = join(bin, 'pnpm.cjs')
    await writeFile(
      script,
      [
        `process.stdout.write('pnpm: bundled one ran\\n')`,
        `for (const name of ['billion-context', 'dsh-git-branch-manage']) require('node:fs').mkdirSync(require('node:path').join(process.cwd(), 'node_modules', name), { recursive: true })`,
        `process.exit(0)`,
      ].join('\n'),
      'utf8',
    )
    process.env.DSH_RESOURCES_DIR = resources
    const result = await installPlugins(paths)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('bundled one ran')
  }, 60_000)
})
