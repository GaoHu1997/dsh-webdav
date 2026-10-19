/**
 * Reading and writing a DSH profile.
 *
 * The contract this suite pins down is the one the whole feature rests on: a
 * sync rewrites two files a person also edits by hand, so a write must leave
 * every comment, every key order and every unrelated row exactly where it was.
 * Reading the file back and comparing the text is the only honest check.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MODELS_ID,
  SELF_ID,
  applyManifest,
  applyPatch,
  collect,
  keepAside,
  keyOf,
  missingPlugins,
  readBundles,
  readManifest,
  readPatch,
  writeAtomic,
  writeIfChanged,
} from '../src/store.ts'
import { cleanUp, tempDir, writeProfile, SAMPLE_MANIFEST, SAMPLE_PATCH, emptyProfile } from './harness.ts'
import { join } from 'node:path'

afterEach(cleanUp)

describe('readPatch', () => {
  it('reads every top-level row, in order', async () => {
    const paths = await writeProfile()
    const patch = await readPatch(paths)
    expect(patch.rows.map(row => row.key)).toEqual([
      'id:ui-chat',
      'id:agent-default-model',
      'id:llm-pi-ai',
      'id:permission',
      'insert:magpie-mcp-context7',
    ])
  })

  it('reads a missing file as an empty patch rather than failing', async () => {
    const paths = await emptyProfile()
    const patch = await readPatch(paths)
    expect(patch.rows).toEqual([])
    expect(patch.text).toBe('')
    expect(patch.mtimeMs).toBe(0)
  })

  it('names the file when it is not readable YAML', async () => {
    const paths = await writeProfile('a: [unclosed\n')
    await expect(readPatch(paths)).rejects.toThrow(/不是可读的 YAML/)
  })

  it('refuses a top level that is not a list of rows', async () => {
    const paths = await writeProfile('just: a mapping\n')
    await expect(readPatch(paths)).rejects.toThrow(/的顶层必须是一串 patch 行/)
  })
})

describe('readManifest', () => {
  it('reads the manifest and its bundles', async () => {
    const paths = await writeProfile()
    const manifest = await readManifest(paths)
    expect(readBundles(manifest.value)).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'billion-context',
    ])
  })

  it('reads a missing file as an empty manifest', async () => {
    const paths = await emptyProfile()
    const manifest = await readManifest(paths)
    expect(manifest.value).toEqual({})
    expect(readBundles(manifest.value)).toEqual([])
  })

  it('names the file when it is not readable JSON', async () => {
    const paths = await writeProfile(SAMPLE_PATCH, '{ not json')
    await expect(readManifest(paths)).rejects.toThrow(/不是可读的 JSON/)
  })
})

describe('collect', () => {
  it('splits a profile into the four parts', async () => {
    const paths = await writeProfile()
    const parts = collect(await readPatch(paths), await readManifest(paths))
    expect(Object.keys(parts).sort()).toEqual(['defaults', 'models', 'patch', 'plugins'])
    const models = parts.models as { config: Record<string, unknown> }
    expect(Object.keys(models.config)).toEqual(['providers'])
    const defaults = parts.defaults as { config: Record<string, unknown> }
    expect(defaults.config['provider']).toBe('free')
    const plugins = parts.plugins as { dependencies: Record<string, string>; bundles: string[] }
    expect(plugins.dependencies['billion-context']).toBe('0.1.197')
    // Everything that is neither of the two model rows: the rest of the setup.
    const patch = parts.patch as { entries: Array<{ id?: string; insert?: unknown[] }> }
    expect(patch.entries.map(entry => keyOf(entry))).toEqual([
      'id:ui-chat',
      'id:permission',
      'insert:magpie-mcp-context7',
    ])
  })

  it('keeps the model rows out of the patch part and the insert block in it', async () => {
    const paths = await writeProfile()
    const parts = collect(await readPatch(paths), await readManifest(paths))
    const patch = parts.patch as { entries: Record<string, unknown>[] }
    const keys = patch.entries.map(entry => keyOf(entry))
    expect(keys).not.toContain(`id:${MODELS_ID}`)
    expect(keys).not.toContain('id:agent-default-model')
    expect(keys).toContain('insert:magpie-mcp-context7')
    // The insert block travels as a block, because it is the loader's own shape:
    // applied on another computer it has to stay an `insert:` list.
    const inserted = patch.entries.find(entry => keyOf(entry) === 'insert:magpie-mcp-context7')
    expect(Array.isArray(inserted?.['insert'])).toBe(true)
    const inner = (inserted?.['insert'] as Record<string, unknown>[])[0]
    expect(inner?.['id']).toBe('magpie-mcp-context7')
    expect(inner?.['name']).toBe('@deepseek-ai/dsh-mcp-client')
  })

  it('omits a part the profile holds nothing for', async () => {
    const paths = await emptyProfile()
    const parts = collect(await readPatch(paths), await readManifest(paths))
    expect(parts).toEqual({})
  })

  it('never carries this plugin\'s own row as a part', async () => {
    const patch = `- id: ${SELF_ID}\n  name: 'dsh-webdav-sync'\n\n${SAMPLE_PATCH}`
    const paths = await writeProfile(patch)
    const parts = collect(await readPatch(paths), await readManifest(paths))
    const entries = (parts.patch as { entries: Array<{ id?: string }> }).entries
    expect(entries.map(entry => keyOf(entry))).not.toContain(`id:${SELF_ID}`)
  })
})

describe('missingPlugins', () => {
  it('names what is declared but not installed', () => {
    const plugins = {
      dependencies: { 'billion-context': '0.1.197', 'dsh-extra': '^1.0.0' },
      bundles: ['@deepseek-ai/dsh-base', 'dsh-third'],
    }
    expect(missingPlugins(plugins, ['billion-context', 'dsh-third'])).toEqual(['dsh-extra'])
  })

  it('ignores the shell\'s own packages, which are not profile plugins', () => {
    const plugins = { dependencies: {}, bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] }
    expect(missingPlugins(plugins, [])).toEqual([])
  })

  it('answers nothing when everything declared is installed', () => {
    const plugins = { dependencies: { a: '1' }, bundles: ['b'] }
    expect(missingPlugins(plugins, ['a', 'b', 'c'])).toEqual([])
  })
})

describe('keyOf', () => {
  it('keys a row by its id and an insert block by its inner rows', () => {
    expect(keyOf({ id: 'ui-chat' })).toBe('id:ui-chat')
    expect(keyOf({ insert: [{ id: 'a' }, { id: 'b' }] })).toBe('insert:a,b')
    // Two anonymous rows must not collide, or one would silently replace the other.
    expect(keyOf({ name: 'x' })).not.toBe(keyOf({ name: 'y' }))
  })
})

describe('applyPatch', () => {
  it('replaces the model config and leaves comments and order alone', async () => {
    const paths = await writeProfile()
    const patch = await readPatch(paths)
    const before = patch.text
    const next = applyPatch(patch, { defaults: { config: { provider: 'wb', model: 'gpt-6-astra', reasoningEffort: 'low' } } })

    expect(next).toContain('# Your patch layer for this dsh profile')
    expect(next).toContain('# the local gateway')
    expect(next).toContain('transcriptView: standard')
    expect(next).toContain('defaultPreset: danger-full-access')
    expect(next).toContain('# magpie')
    expect(next).toContain('provider: wb')
    expect(next).not.toContain('provider: free')
    // The row order is the profile's, unchanged.
    expect(next.indexOf('id: ui-chat')).toBeLessThan(next.indexOf('id: agent-default-model'))
    expect(next.indexOf('id: agent-default-model')).toBeLessThan(next.indexOf('id: llm-pi-ai'))
    expect(next).not.toBe(before)
  })

  it('writes a whole model catalog back without disturbing the rest', async () => {
    const paths = await writeProfile()
    const patch = await readPatch(paths)
    const config = {
      providers: {
        only: { displayName: '只有这一个', apiKeyEnv: 'ONLY_API_KEY', models: [{ id: 'm', name: 'M' }] },
      },
    }
    const next = applyPatch(patch, { models: { config } })
    const written = await writeProfile(next)
    const parts = collect(await readPatch(written), await readManifest(written))
    expect((parts.models as { config: unknown }).config).toEqual(config)
    expect(next).toContain('# the local gateway')
    expect(next).toContain('url: https://mcp.context7.com/mcp')
  })

  it('replaces the patch part and keeps the model rows where they stand', async () => {
    const paths = await writeProfile()
    const patch = await readPatch(paths)
    const entries = [
      { id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat', config: { transcriptView: 'compact' } },
      { id: 'brand-new', name: 'some-plugin', config: { on: true } },
    ]
    const next = applyPatch(patch, { patch: { entries } })
    const written = await writeProfile(next)
    const parts = collect(await readPatch(written), await readManifest(written))
    const ids = (parts.patch as { entries: Array<{ id: string }> }).entries.map(entry => entry.id)
    expect(ids.sort()).toEqual(['brand-new', 'ui-chat'])
    // The model catalog came from the base text and was not touched.
    expect(written.text ?? (await readPatch(written)).text).toContain('group/auto-deepseek-v4-1-flash')
    expect(next.indexOf('id: llm-pi-ai')).toBeLessThan(next.indexOf('id: brand-new'))
  })

  it('adds a missing model row rather than dropping the part', async () => {
    const paths = await writeProfile('- id: ui-chat\n  name: x\n')
    const patch = await readPatch(paths)
    const next = applyPatch(patch, {
      models: { config: { providers: { one: { apiKeyEnv: 'K' } } } },
      defaults: { config: { provider: 'one', model: 'm' } },
    })
    const written = await writeProfile(next)
    const parts = collect(await readPatch(written), await readManifest(written))
    expect((parts.models as { config: unknown }).config).toEqual({ providers: { one: { apiKeyEnv: 'K' } } })
    // The row it adds carries the name the loader needs to resolve it.
    expect(next).toContain('@deepseek-ai/dsh-llm-pi-ai')
    expect(next).toContain('@deepseek-ai/dsh-agent-default-model')
  })

  it('writes into a row that has no config key at all', async () => {
    // A hand-written row can leave out `config:`. That is a row that is kept and
    // merged into, not a row to throw the whole file away over.
    const paths = await writeProfile('- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n')
    const patch = await readPatch(paths)
    const next = applyPatch(patch, {
      patch: { entries: [{ id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat', config: { transcriptView: 'compact' } }] },
    })
    expect(next).toContain('transcriptView: compact')
    const written = await writeProfile(next)
    const parts = collect(await readPatch(written), await readManifest(written))
    expect((parts.patch as { entries: Array<{ config?: unknown }> }).entries[0]?.config).toEqual({ transcriptView: 'compact' })
  })

  it('leaves a row without a config key alone when there is nothing to put in it', async () => {
    const text = '- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n'
    const paths = await writeProfile(text)
    const next = applyPatch(await readPatch(paths), {
      patch: { entries: [{ id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat' }] },
    })
    // No empty `config:` is invented, and the row is still readable.
    expect(next).not.toContain('config:')
    expect(collect(await readPatch(await writeProfile(next)), await readManifest(await writeProfile(next)))).toBeDefined()
  })

  it('keeps two insert blocks that have no ids of their own', async () => {
    // Neither block can be named, so they are keyed by what they hold. Keying
    // them the same would let one silently overwrite the other.
    const paths = await writeProfile(`- insert:
    - id: alpha
      name: one
    - id: beta
      name: two
`)
    const next = applyPatch(await readPatch(paths), {
      patch: {
        entries: [
          { insert: [{ id: 'alpha', name: 'one' }] },
          { insert: [{ id: 'beta', name: 'two' }] },
        ],
      },
    })
    const entries = (collect(await readPatch(await writeProfile(next)), await readManifest(await writeProfile(next))).patch as {
      entries: Array<{ insert?: Array<{ name?: string }> }>
    }).entries
    const names = entries.flatMap(entry => (entry.insert ?? []).map(row => row.name))
    expect(names).toContain('one')
    expect(names).toContain('two')
  })

  it('builds a whole patch from nothing when the profile has none', async () => {
    const paths = await emptyProfile()
    const patch = await readPatch(paths)
    const next = applyPatch(patch, {
      defaults: { config: { provider: 'free', model: 'g' } },
      patch: { entries: [{ id: 'ui-chat', name: 'x', config: {} }] },
    })
    const written = await writeProfile(next)
    const parts = collect(await readPatch(written), await readManifest(written))
    expect((parts.defaults as { config: unknown }).config).toEqual({ provider: 'free', model: 'g' })
    expect((parts.patch as { entries: Array<{ id: string }> }).entries.map(e => e.id)).toEqual(['ui-chat'])
  })

  it('leaves the file byte-identical when the merge decided nothing', async () => {
    const paths = await writeProfile()
    const patch = await readPatch(paths)
    const parts = collect(patch, await readManifest(paths))
    const next = applyPatch(patch, {
      models: parts.models as { config: Record<string, unknown> },
      defaults: parts.defaults as { config: Record<string, unknown> },
      patch: parts.patch as never,
    })
    // Every part written came from the same file, so nothing may change: not a
    // space, not a quote style, not the trailing comment.
    expect(next).toBe(patch.text)
  })
})

describe('applyManifest', () => {
  it('merges dependencies and writes the bundle order', async () => {
    const paths = await writeProfile()
    const manifest = await readManifest(paths)
    const next = applyManifest(manifest, {
      dependencies: { 'billion-context': '0.2.0', 'new-plugin': '^1.0.0' },
      bundles: ['@deepseek-ai/dsh-base', 'new-plugin'],
    })
    const written = await writeProfile(SAMPLE_PATCH, next)
    const after = await readManifest(written)
    expect(after.value['dependencies']).toEqual({ 'billion-context': '0.2.0', 'new-plugin': '^1.0.0' })
    expect(readBundles(after.value)).toEqual(['@deepseek-ai/dsh-base', 'new-plugin'])
    // Unrelated manifest keys survive.
    expect(after.value['name']).toBe('dsh-profile-desktop')
    expect(next.endsWith('\n')).toBe(true)
  })

  it('drops a plugin the other computer no longer has', async () => {
    const paths = await writeProfile()
    const manifest = await readManifest(paths)
    const next = applyManifest(manifest, { dependencies: {}, bundles: [] })
    const written = await writeProfile(SAMPLE_PATCH, next)
    const after = await readManifest(written)
    expect(after.value['dependencies']).toEqual({})
    expect(readBundles(after.value)).toEqual([])
  })
})

describe('writeIfChanged', () => {
  it('does not touch a file whose bytes already match', async () => {
    const dir = await tempDir()
    const file = join(dir, 'x.txt')
    await writeFile(file, 'same\n', 'utf8')
    expect(await writeIfChanged(file, 'same\n')).toBe(false)
    expect(await writeIfChanged(file, 'different\n')).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('different\n')
  })
})

describe('writeAtomic', () => {
  it('makes the directory it needs and leaves no temp file behind', async () => {
    const dir = await tempDir()
    const file = join(dir, 'nested', 'y.txt')
    // A profile's directory always exists, so the writer creates intermediate
    // paths rather than failing on the first sync into a fresh profile.
    await writeAtomic(file, 'hello', 0o600)
    expect(await readFile(file, 'utf8')).toBe('hello')
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(join(dir, 'nested'))).toEqual(['y.txt'])
  })

  it('replaces the bytes of a file that is already there', async () => {
    const dir = await tempDir()
    const file = join(dir, 'z.txt')
    await writeAtomic(file, 'first')
    await writeAtomic(file, 'second')
    expect(await readFile(file, 'utf8')).toBe('second')
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(dir)).toEqual(['z.txt'])
  })
})

describe('keepAside', () => {
  it('keeps replaced copies and prunes to the newest few', async () => {
    const dir = await tempDir()
    const kept: string[] = []
    for (let i = 0; i < 8; i += 1) {
      kept.push(await keepAside(dir, 'before-apply', `copy ${i}`, 3))
    }
    const { readdir } = await import('node:fs/promises')
    const names = await readdir(dir)
    expect(names).toHaveLength(3)
    // Every kept file is named for the tag, so the folder explains itself.
    for (const name of names) expect(name).toMatch(/-before-apply\.prop$/)
    // The newest three survive: an undo points at the last thing kept.
    expect(names).toContain(kept[7]?.split(/[\\/]/).pop())
    expect(names).not.toContain(kept[0]?.split(/[\\/]/).pop())
    // The copies are distinct files: one kept in the same second must not
    // overwrite the one before it, or an undo would restore the wrong bytes.
    expect(new Set(kept).size).toBe(8)
  })
})
