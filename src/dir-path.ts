/** Browser-safe identities for extra paths; `~` always means DSH_HOME. */

interface AbsolutePath {
  root: string
  parts: string[]
  windows: boolean
}

/** `~user` is deliberately not a portable path. */
export function homeRelative(path: string): boolean {
  return /^~(?:[\\/]|$)/.test(path)
}

/** Reject traversal above the home, NULs and drive-qualified portable suffixes. */
export function homePathParts(path: string): string[] | undefined {
  if (!homeRelative(path) || path.includes('\0')) return undefined
  const parts: string[] = []
  for (const part of path.slice(1).split(/[\\/]+/)) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return undefined
      parts.pop()
    } else {
      if (part.includes(':')) return undefined
      parts.push(part)
    }
  }
  return parts
}

function absolutePath(path: string): AbsolutePath | undefined {
  if (path.includes('\0')) return undefined
  const drive = /^([a-z]:)[\\/]/i.exec(path)
  const unc = /^(?:\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)(?:[\\/]|$)/.exec(path)
  const windows = drive !== null || unc !== null
  const root = drive?.[1] ?? (unc === null ? '/' : `//${unc[1]}/${unc[2]}`)
  const prefix = drive?.[0].length ?? unc?.[0].length ?? 1
  if (!windows && !path.startsWith('/')) return undefined
  const parts: string[] = []
  for (const part of path.slice(prefix).split(windows ? /[\\/]+/ : '/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return { root, parts, windows }
}

/** Convert only paths inside the actual home; never replace a username by guesswork. */
export function portableDirPath(value: string, home?: string | undefined): string {
  const path = value.trim()
  if (homeRelative(path)) {
    const parts = homePathParts(path)
    return parts === undefined ? path : parts.length === 0 ? '~' : `~/${parts.join('/')}`
  }
  if (home === undefined || home.trim() === '') return path
  const base = absolutePath(home.trim())
  const target = absolutePath(path)
  if (base === undefined || target === undefined || base.windows !== target.windows) return path
  const same = (a: string, b: string): boolean => base.windows ? a.toLowerCase() === b.toLowerCase() : a === b
  if (!same(base.root, target.root) || target.parts.length < base.parts.length) return path
  if (!base.parts.every((part, index) => same(part, target.parts[index] ?? ''))) return path
  const rest = target.parts.slice(base.parts.length)
  // A POSIX filename can contain a backslash; that spelling is not a portable
  // separator and must not silently become a different file on this machine.
  if (!target.windows && rest.some(part => part.includes('\\'))) return path
  const portable = rest.length === 0 ? '~' : `~/${rest.join('/')}`
  return homePathParts(portable) === undefined ? path : portable
}

/**
 * Old backups had no source-home metadata. Only the conventional DSH home is
 * recognisable across machines; a custom absolute root is not safe to guess.
 * Match the original prefix before reducing dots, so an escaping suffix stays
 * an invalid `~` path rather than becoming a write to the source user's parent.
 */
export function legacyDirPath(value: string, home?: string | undefined): string {
  const path = portableDirPath(value, home)
  if (homeRelative(path)) return path
  const match = /^[a-z]:[\\/]Users[\\/]([^\\/]+)[\\/]\.dsh(?:[\\/]|$)/i.exec(path)
    ?? /^\/(?:home|Users)\/([^/]+)\/\.dsh(?:\/|$)/.exec(path)
    ?? /^\/root\/\.dsh(?:\/|$)/.exec(path)
  if (match === null || match[1] === '.' || match[1] === '..') return path
  const suffix = path.slice(match[0].length)
  if (!/^[a-z]:[\\/]/i.test(path) && suffix.includes('\\')) return path
  return portableDirPath(`~/${suffix}`)
}
