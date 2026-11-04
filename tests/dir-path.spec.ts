import { describe, expect, it } from 'vitest'
import { homePathParts, homeRelative, legacyDirPath, portableDirPath } from '../src/dir-path.js'

describe('portable extra-path identities', () => {
  it('uses the actual home on both Windows and POSIX with a strict boundary', () => {
    expect(portableDirPath('C:\\Users\\gaohu\\.dsh\\AGENTS.md', 'c:/users/GAOHU/.dsh')).toBe('~/AGENTS.md')
    expect(portableDirPath('C:/Users/gaohu/.dsh-other/a', 'C:/Users/gaohu/.dsh')).toBe('C:/Users/gaohu/.dsh-other/a')
    expect(portableDirPath('/home/a/custom/notes', '/home/a/custom')).toBe('~/notes')
    expect(portableDirPath('/home/a/Custom/notes', '/home/a/custom')).toBe('/home/a/Custom/notes')
    expect(portableDirPath('/home/a/custom', '/home/a/custom')).toBe('~')
    expect(portableDirPath('\\\\SERVER\\share\\dsh\\notes', '//server/SHARE/dsh')).toBe('~/notes')
  })

  it('never guesses a home for a local selection or rewrites an external root', () => {
    expect(portableDirPath('C:/Users/a/.dsh/AGENTS.md')).toBe('C:/Users/a/.dsh/AGENTS.md')
    expect(portableDirPath('/data/my-dsh/AGENTS.md', '/home/a/.dsh')).toBe('/data/my-dsh/AGENTS.md')
    expect(portableDirPath('/data/dsh/a\\b', '/data/dsh')).toBe('/data/dsh/a\\b')
  })

  it('canonicalises portable separators and safe dots while rejecting escape and NUL', () => {
    expect(homeRelative('~\\notes')).toBe(true)
    expect(homeRelative('~someone/notes')).toBe(false)
    expect(portableDirPath(' ~\\notes\\.\\sub\\..\\a ')).toBe('~/notes/a')
    expect(homePathParts('~/../outside')).toBeUndefined()
    expect(homePathParts('~\\notes\\..\\..\\outside')).toBeUndefined()
    expect(homePathParts('~/C:/outside')).toBeUndefined()
    expect(homePathParts('~/a\0b')).toBeUndefined()
    expect(homePathParts('~/notes/../a')).toEqual(['a'])
  })

  it('recognises only old conventional DSH homes across operating systems', () => {
    for (const path of ['C:/Users/alice/.dsh/AGENTS.md', 'd:\\users\\Alice\\.DSH\\AGENTS.md', '/home/alice/.dsh/AGENTS.md', '/Users/alice/.dsh/AGENTS.md', '/root/.dsh/AGENTS.md']) {
      expect(legacyDirPath(path)).toBe('~/AGENTS.md')
    }
    for (const path of ['C:/work/.dsh/AGENTS.md', '/srv/custom/AGENTS.md', '/home/alice/.dsh-other/AGENTS.md', '//server/share/.dsh/AGENTS.md']) {
      expect(legacyDirPath(path, '/home/b/.dsh')).toBe(path)
    }
  })

  it('does not reinterpret a literal POSIX backslash during legacy migration', () => {
    for (const root of ['/home/ada/.dsh', '/Users/ada/.dsh', '/root/.dsh']) {
      const path = `${root}/a\\b`
      expect(legacyDirPath(path, root)).toBe(path)
      expect(legacyDirPath(path, '/custom/home')).toBe(path)
    }
    expect(legacyDirPath('C:/Users/ada/.dsh/a\\b')).toBe('~/a/b')
  })

  it('does not reduce a legacy default-home escape into an absolute write', () => {
    expect(legacyDirPath('C:/Users/alice/.dsh/../outside')).toBe('~/../outside')
    expect(homePathParts(legacyDirPath('/home/alice/.dsh/a/../../outside'))).toBeUndefined()
  })
})
