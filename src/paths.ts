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
  /**
   * The home patch DSH layers over every profile, when this set of paths knows
   * the home directory.
   *
   * Absent rather than guessed for the callers that only know a profile: a
   * throwaway profile in a test must never read, and above all never write, the
   * home directory of the machine running it. See
   * `docs/decisions/0071-sync-the-catalog-where-it-takes-effect.md`.
   */
  homePatchFile?: string
  /**
   * The `$DSH_HOME/skills` directory holding the skill folders this computer's
   * host discovers, when this set of paths knows the home directory.
   *
   * Absent rather than guessed, for the same reason as {@link homePatchFile}: a
   * throwaway profile in a test must never read, and above all never write, the
   * skills of the machine running it.
   */
  skillsDir?: string
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
export function resolvePaths(profileDir: string, homeDir?: string): ResolvedPaths {
  const dir = resolve(profileDir)
  return {
    profileDir: dir,
    stateDir: join(dir, STATE_DIR_NAME),
    patchFile: join(dir, 'cordis.patch.yml'),
    ...(homeDir === undefined
      ? {}
      : {
          homePatchFile: join(resolve(homeDir), 'cordis.patch.yml'),
          skillsDir: join(resolve(homeDir), 'skills'),
        }),
    packageFile: join(dir, 'package.json'),
    baseFile: join(dir, 'cordis.yml'),
  }
}

/** Resolve everything from the environment in one call. */
export function resolveFromEnv(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedPaths {
  return resolvePaths(resolveProfileDir(configured, env), resolveHome(env))
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
