/**
 * Where this plugin's files live. A DSH installation has exactly one active
 * profile directory at a time — the profile whose `cordis.patch.yml` holds the
 * model catalog and whose `package.json` lists the installed plugins — so the
 * profile directory is resolved once, from the composition's own environment,
 * and everything else is derived from it.
 *
 * Resolution order mirrors `dsh-git-branch/src/settings.ts`: an explicit value
 * wins, then `$DSH_HOME`, then `~/.dsh`. A blank string counts as unset.
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Every path this plugin resolves, computed once per call site. */
export interface ResolvedPaths {
  /** The active profile directory, or the best guess at one. */
  profileDir: string
  /** Where this plugin keeps its configuration and sync state. */
  stateDir: string
  /** The profile patch holding the model catalog and the other patch rows. */
  patchFile: string
  /** The profile manifest holding the installed-plugin list. */
  packageFile: string
  /** Legacy composition file, read only to seed a first sync when the patch is empty. */
  baseFile: string
}

/** The environment variable DSH sets to the running profile's directory. */
export const ENV_PROFILE_DIR = 'DSH_PROFILE_DIR'
/** The environment variable DSH sets to its home directory. */
export const ENV_HOME = 'DSH_HOME'
/** The environment variable DSH sets to the running profile's name. */
export const ENV_PROFILE = 'DSH_PROFILE'

/** Directory name this plugin owns inside the profile directory. */
export const STATE_DIR_NAME = '.dsh-webdav-sync'

/**
 * The relay's own directory name inside the profile directory.
 *
 * Deliberately a sibling of {@link STATE_DIR_NAME} rather than a file inside it:
 * the relay is not part of the sync and must not look like it is. Nothing the
 * sync reads or writes is under here, and nothing here travels with a setup.
 */
export const RELAY_DIR_NAME = '.dsh-webdav-relay'
/** The relay's own configuration file, inside {@link RELAY_DIR_NAME}. */
export const RELAY_FILE_NAME = 'relay.json'

/** The relay's own paths: one directory, one file, shared with nobody. */
export interface RelayPaths {
  /** The relay's directory under the profile directory. */
  dir: string
  /** The relay's configuration file. */
  file: string
}

/** The relay's paths, derived from the profile directory like everything else. */
export function resolveRelayPaths(profileDir: string): RelayPaths {
  const dir = join(resolve(profileDir), RELAY_DIR_NAME)
  return { dir, file: join(dir, RELAY_FILE_NAME) }
}

/**
 * `true` when a candidate would be read as unset: absent, not a string, or
 * nothing but whitespace.
 */
export function blank(value: string | undefined | null): boolean {
  return typeof value !== 'string' || value.trim() === ''
}

/**
 * The profile directory in force.
 *
 * `DSH_PROFILE_DIR` is authoritative when the composition set it. Without it,
 * `$DSH_HOME/profiles/<DSH_PROFILE>` is used; without that, `~/.dsh/profiles/desktop`.
 */
export function resolveProfileDir(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!blank(configured) && isAbsolute(configured!.trim())) return resolve(configured!.trim())
  const named = env[ENV_PROFILE_DIR]
  if (!blank(named) && isAbsolute(named!.trim())) return resolve(named!.trim())
  const home = resolveHome(env)
  const profile = blank(env[ENV_PROFILE]) ? 'desktop' : env[ENV_PROFILE]!.trim()
  return join(home, 'profiles', profile)
}

/**
 * The DSH home directory: `$DSH_HOME` when it names an absolute path, `~/.dsh`
 * otherwise. A blank value counts as unset.
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env[ENV_HOME]
  if (!blank(home) && isAbsolute(home!.trim())) return resolve(home!.trim())
  return join(homedir(), '.dsh')
}

/** Every path derived from one profile directory. */
export function resolvePaths(profileDir: string): ResolvedPaths {
  const dir = resolve(profileDir)
  return {
    profileDir: dir,
    stateDir: join(dir, STATE_DIR_NAME),
    patchFile: join(dir, 'cordis.patch.yml'),
    packageFile: join(dir, 'package.json'),
    baseFile: join(dir, 'cordis.yml'),
  }
}

/** Resolve everything from the environment in one call. */
export function resolveFromEnv(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPaths {
  return resolvePaths(resolveProfileDir(configured, env))
}

/**
 * Reject a profile directory the plugin cannot work in, with the reason, so a
 * misconfiguration is reported where it is set rather than at the first sync.
 */
export function validateProfileDir(profileDir: string): void {
  if (blank(profileDir)) throw new Error('WebdavSyncConfig：「profileDir」必须是非空字符串')
  if (!isAbsolute(profileDir.trim())) {
    throw new Error(`WebdavSyncConfig：「profileDir」必须是绝对路径，收到的是「${profileDir}」`)
  }
}
