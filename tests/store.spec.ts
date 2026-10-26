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
  DEFAULTS_ID,
  MODELS_ID,
  SELF_ID,
  applyManifest,
  applyPatch,
  collect,
  isMcpEntry,
  joinMcp,
  keepAside,
  keyOf,
  missingPlugins,
  readBundles,
  readHomePatch,
  readManifest,
  readPatch,
  modelsLayer,
  splitMcp,
  writeAtomic,
  writeIfChanged,
} from '../src/store.ts'
import { cleanUp, tempDir, writeProfile, SAMPLE_MANIFEST, SAMPLE_PATCH, emptyProfile } from './harness.ts'
import { join } from 'node:path'
import type { ResolvedPaths } from '../src/paths.ts'

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
  it('splits a profile into the parts it carries', async () => {
    const paths = await writeProfile()
    const parts = collect(await readPatch(paths), await readManifest(paths))
    expect(Object.keys(parts).sort()).toEqual(['mcp', 'models', 'patch', 'plugins'])
    const models = parts.models as { config: Record<string, unknown> }
    expect(Object.keys(models.config)).toEqual(['providers'])
    const plugins = parts.plugins as { dependencies: Record<string, string>; bundles: string[] }
    expect(plugins.dependencies['billion-context']).toBe('0.1.197')
    // Everything that is neither of the two model rows and not an MCP row: the
    // rest of the setup. The MCP block is lifted out below.
    const patch = parts.patch as { entries: Array<{ id?: string; insert?: unknown[] }> }
    expect(patch.entries.map(entry => keyOf(entry))).toEqual([
      'id:ui-chat',
      'id:permission',
    ])
    const mcp = parts.mcp as { entries: Array<{ id?: string; insert?: unknown[] }> }
    expect(mcp.entries.map(entry => keyOf(entry))).toEqual([
      'insert:magpie-mcp-context7',
    ])
  })

  it('keeps the model rows out of the patch part and lifts the MCP rows out of it', async () => {
    const paths = await writeProfile()
    const parts = collect(await readPatch(paths), await readManifest(paths))
    const patch = parts.patch as { entries: Record<string, unknown>[] }
    const keys = patch.entries.map(entry => keyOf(entry))
    expect(keys).not.toContain(`id:${MODELS_ID}`)
    // The default-model row is not a part at all: it stays out of the mirror as
    // well, so changing the model on one computer is not a change here.
    expect(keys).not.toContain(`id:${DEFAULTS_ID}`)
    // The MCP client's own block is the `mcp` part, not the patch part's: it is
    // named apart so its switch is its own, while the wire keeps carrying the
    // block inside the patch field. See docs/decisions/0075-mcp-and-skills-parts.md.
    expect(keys).not.toContain('insert:magpie-mcp-context7')
    const mcp = parts.mcp as { entries: Record<string, unknown>[] }
    expect(mcp.entries.map(entry => keyOf(entry))).toEqual(['insert:magpie-mcp-context7'])
    // The block travels as a block, because it is the loader's own shape:
    // applied on another computer it has to stay an `insert:` list.
    const inserted = mcp.entries.find(entry => keyOf(entry) === 'insert:magpie-mcp-context7')
    expect(Array.isArray(inserted?.['insert'])).toBe(true)
    const inner = (inserted?.['insert'] as Record<string, unknown>[])[0]
    expect(inner?.['id']).toBe('magpie-mcp-context7')
    expect(inner?.['name']).toBe('@deepseek-ai/dsh-mcp-client')
  })

  it('collects the last model config, not an earlier overridden catalog', async () => {
    const paths = await writeProfile(`${SAMPLE_PATCH}
- id: llm-pi-ai
  config:
    providers:
      wb:
        models: [{ id: newer }, { id: older }]
      free: {}
- id: llm-pi-ai
  disabled: false
`)
    const parts = collect(await readPatch(paths), await readManifest(paths))
    const providers = parts.models?.config.providers as Record<string, { models?: { id: string }[] }>
    expect(Object.keys(providers)).toEqual(['wb', 'free'])
    expect(providers.wb?.models?.map(model => model.id)).toEqual(['newer', 'older'])
    expect(parts.patch?.entries.map(keyOf)).not.toContain(`id:${MODELS_ID}`)
  })

  it('honors an explicit empty model config after a populated one', async () => {
    const paths = await writeProfile(`${SAMPLE_PATCH}\n- id: llm-pi-ai\n  config: {}\n`)
    expect(collect(await readPatch(paths), await readManifest(paths)).models).toEqual({ config: {} })
  })

  it('ignores model overrides whose plugin name does not match', async () => {
    const paths = await writeProfile(`${SAMPLE_PATCH}\n- id: llm-pi-ai\n  name: some-other-adapter\n  config: {}\n`)
    const parts = collect(await readPatch(paths), await readManifest(paths))
    expect(Object.keys(parts.models?.config.providers as object)).toEqual(['free', 'wb'])
  })

  it('does not invent a model part from skipped overrides or insert blocks', async () => {
    const paths = await writeProfile(`
- id: llm-pi-ai
  name: some-other-adapter
  config: { providers: { skipped: {} } }
- id: llm-pi-ai
  insert:
    - id: local-only
      name: local-plugin
`)
    const patch = await readPatch(paths)
    const parts = collect(patch, await readManifest(paths))
    expect(parts).not.toHaveProperty('models')
    expect(applyPatch(patch, parts)).toBe(patch.text)
  })

  it('keeps a metadata-only model row as an empty part without adding config', async () => {
    const paths = await writeProfile('- id: llm-pi-ai\n  disabled: true\n')
    const patch = await readPatch(paths)
    const parts = collect(patch, await readManifest(paths))
    expect(parts.models).toEqual({ config: {} })
    expect(applyPatch(patch, parts)).toBe(patch.text)
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
    const next = applyPatch(patch, { models: { config: { providers: { wb: { apiKeyEnv: 'WB_API_KEY' } } } } })

    expect(next).toContain('# Your patch layer for this dsh profile')
    expect(next).toContain('# the local gateway')
    expect(next).toContain('transcriptView: standard')
    expect(next).toContain('defaultPreset: danger-full-access')
    expect(next).toContain('# magpie')
    expect(next).toContain('apiKeyEnv: WB_API_KEY')
    expect(next).not.toContain('apiKeyEnv: FREE_API_KEY')
    // The default-model row beside it is not carried at all, so the merge must
    // not touch it: it keeps its provider and the comment on that line.
    expect(next).toContain('provider: free # the local gateway')
    // The row order is the profile's, unchanged.
    expect(next.indexOf('id: ui-chat')).toBeLessThan(next.indexOf(`id: ${DEFAULTS_ID}`))
    expect(next.indexOf(`id: ${DEFAULTS_ID}`)).toBeLessThan(next.indexOf(`id: ${MODELS_ID}`))
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
    })
    const written = await writeProfile(next)
    const parts = collect(await readPatch(written), await readManifest(written))
    expect((parts.models as { config: unknown }).config).toEqual({ providers: { one: { apiKeyEnv: 'K' } } })
    // The row it adds carries the name the loader needs to resolve it.
    expect(next).toContain('@deepseek-ai/dsh-llm-pi-ai')
    // And nothing else is invented: the row it used to append beside this one is
    // no longer a part, so a profile that never had one does not gain one.
    expect(next).not.toContain('@deepseek-ai/dsh-agent-default-model')
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
      models: { config: { providers: { one: { apiKeyEnv: 'K' } } } },
      patch: { entries: [{ id: 'ui-chat', name: 'x', config: {} }] },
    })
    const written = await writeProfile(next)
    const parts = collect(await readPatch(written), await readManifest(written))
    expect((parts.models as { config: unknown }).config).toEqual({ providers: { one: { apiKeyEnv: 'K' } } })
    expect((parts.patch as { entries: Array<{ id: string }> }).entries.map(e => e.id)).toEqual(['ui-chat'])
  })

  it('leaves the file byte-identical when the merge decided nothing', async () => {
    const paths = await writeProfile()
    const patch = await readPatch(paths)
    const parts = collect(patch, await readManifest(paths))
    const next = applyPatch(patch, {
      models: parts.models as { config: Record<string, unknown> },
      patch: parts.patch as never,
    })
    // Every part written came from the same file, so nothing may change: not a
    // space, not a quote style, not the trailing comment.
    expect(next).toBe(patch.text)
  })
})

describe('the rows the mcp part is made of', () => {
  // These are the rules the `mcp` part is carved out of the patch file with
  // (docs/decisions/0075-mcp-and-skills-parts.md): what counts as an MCP row
  // decides which switch a person is flipping, and a row left behind here is a
  // row silently synced by the wrong one.
  const CLIENT = '@deepseek-ai/dsh-mcp-client'

  it('takes the MCP client’s own rows, named directly', () => {
    expect(isMcpEntry({ id: 'magpie-local', name: CLIENT, config: {} })).toBe(true)
    // ...whether or not a row of that name has an id.
    expect(isMcpEntry({ name: CLIENT })).toBe(true)
  })

  it('takes a whole insert block of MCP rows', () => {
    expect(isMcpEntry({ insert: [{ id: 'one', name: CLIENT }, { id: 'two', name: CLIENT }] })).toBe(true)
  })

  it('leaves everything else to the patch part', () => {
    expect(isMcpEntry({ id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat' })).toBe(false)
    // A block holding rows of another plugin is that plugin's business.
    expect(isMcpEntry({ insert: [{ id: 'one', name: CLIENT }, { id: 'two', name: 'other' }] })).toBe(false)
    // An insert block with an id of its own is a row like any other — it is
    // keyed and merged by that id rather than by what it holds.
    expect(isMcpEntry({ id: 'named-block', insert: [{ id: 'one', name: CLIENT }] })).toBe(false)
    expect(isMcpEntry({ insert: [] })).toBe(false)
    expect(isMcpEntry('a string row')).toBe(false)
  })

  it('parts a list and rejoins it with nothing gained or lost', () => {
    const rest = [
      { id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat' },
      { id: 'permission', name: 'x' },
    ]
    const mcp = [{ insert: [{ id: 'one', name: CLIENT }] }]
    const joined = joinMcp(rest, mcp)

    expect(joined.map((entry) => keyOf(entry))).toEqual(['id:ui-chat', 'id:permission', 'insert:one'])
    // The wire's `patch` field is the join; a read parts it back the same way.
    expect(splitMcp(joined)).toEqual({ rest, mcp })
  })
})

describe('applyPatch with the mcp part parted out', () => {
  const CLIENT = '@deepseek-ai/dsh-mcp-client'

  it('writes each part into its own rows of the one file', async () => {
    const paths = await writeProfile()
    const patch = await readPatch(paths)
    const next = applyPatch(patch, {
      patch: {
        entries: [
          { id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat', config: { transcriptView: 'compact' } },
          { id: 'permission', name: 'x' },
        ],
      },
      mcp: { entries: [{ insert: [{ id: 'fresh', name: CLIENT, config: { command: 'new' } }] }] },
    })

    const parts = collect(await readPatch(await writeProfile(next)), await readManifest(await writeProfile(next)))
    const rest = (parts.patch as { entries: Array<{ id?: string }> }).entries.map((entry) => entry.id)
    expect(rest).toEqual(['ui-chat', 'permission'])
    const mcp = (parts.mcp as { entries: Array<{ insert?: Array<{ id?: string }> }> }).entries
    expect(mcp.map((entry) => keyOf(entry))).toEqual(['insert:fresh'])
  })

  it('leaves a class alone when the merge said nothing about it', async () => {
    // Three states, not two: a wanted list with entries replaces, an empty one
    // removes, and an absent one keeps whatever the file holds. That is what
    // makes the rows safe with a computer that does not know the parts yet.
    const paths = await writeProfile()
    const patch = await readPatch(paths)
    const next = applyPatch(patch, {
      patch: { entries: [{ id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat' }] },
    })

    const parts = collect(await readPatch(await writeProfile(next)), await readManifest(await writeProfile(next)))
    expect((parts.mcp as { entries: unknown[] }).entries).toHaveLength(1)
  })

  it('removes rows per class, so one switch takes away only its own', async () => {
    const paths = await writeProfile()
    const clearedMcp = applyPatch(await readPatch(paths), { mcp: { entries: [] } })
    const parts = collect(await readPatch(await writeProfile(clearedMcp)), await readManifest(await writeProfile(clearedMcp)))
    expect(parts.mcp).toBeUndefined()
    expect((parts.patch as { entries: unknown[] }).entries).toHaveLength(2)

    const clearedRest = applyPatch(await readPatch(paths), { patch: { entries: [] } })
    const parts2 = collect(await readPatch(await writeProfile(clearedRest)), await readManifest(await writeProfile(clearedRest)))
    expect(parts2.patch).toBeUndefined()
    expect((parts2.mcp as { entries: unknown[] }).entries).toHaveLength(1)
  })

  it('carries a named MCP row through the same part', async () => {
    const text = `- id: ui-chat\n  name: "@deepseek-ai/dsh-client-ui-chat"\n- id: local\n  name: "${CLIENT}"\n  config:\n    command: old\n`
    const paths = await writeProfile(text)
    const patch = await readPatch(paths)
    const parts = collect(patch, await readManifest(paths))
    expect((parts.mcp as { entries: Array<{ id?: string }> }).entries.map((entry) => entry.id)).toEqual(['local'])

    const next = applyPatch(patch, {
      mcp: { entries: [{ id: 'local', name: CLIENT, config: { command: 'new' } }] },
    })
    // Merged into the row where it stood, not appended at the end.
    expect(next).toContain('command: new')
    expect(next).not.toContain('command: old')
    expect(next.indexOf('id: ui-chat')).toBeLessThan(next.indexOf('id: local'))
  })
})

describe('the model catalog order', () => {
  // DSH lists the models in the order `config.providers` names the routes — it
  // walks the map in the map's own order — so a provider moved up or down is a
  // change to the list a person sees, not YAML layout. Sorted hashing and a merge
  // that keeps every key where it found it each said otherwise, and two computers
  // kept different orders while both reported being in sync.
  it('writes a provider list whose order changed, and nothing else', async () => {
    const paths = await writeProfile()
    const patch = await readPatch(paths)
    const parts = collect(patch, await readManifest(paths))
    const config = (parts.models as { config: { providers: Record<string, unknown> } }).config
    const reversed = { ...config, providers: Object.fromEntries(Object.entries(config.providers).reverse()) }

    const next = applyPatch(patch, { models: { config: reversed } })

    // Nothing but the order changed, and that still has to reach the file.
    expect(next).not.toBe(patch.text)
    expect(next.indexOf('      wb:')).toBeLessThan(next.indexOf('      free:'))
    // The routes themselves are the ones that were already there, comments and
    // all — only their place in the list moved.
    expect(next).toContain('apiKeyEnv: WB_API_KEY')
    expect(next).toContain('apiKeyEnv: FREE_API_KEY')
    expect(next).toContain('# Your patch layer for this dsh profile')

    const written = await writeProfile(next)
    const after = collect(await readPatch(written), await readManifest(written))
    const order = Object.keys((after.models as { config: { providers: Record<string, unknown> } }).config.providers)
    expect(order).toEqual(['wb', 'free'])
  })

  it('updates the effective catalog while leaving later metadata and skipped rows alone', async () => {
    const paths = await writeProfile(`${SAMPLE_PATCH}
- id: llm-pi-ai
  config:
    providers:
      wb: {}
      free: {}
- id: llm-pi-ai
  disabled: false # local switch
- id: llm-pi-ai
  name: some-other-adapter
  config: { untouched: true }
- id: llm-pi-ai
  insert:
    - id: local-only
      name: local-plugin
`)
    const patch = await readPatch(paths)
    const parts = collect(patch, await readManifest(paths))
    expect(applyPatch(patch, parts)).toBe(patch.text)
    const models = { config: { providers: { free: { models: [{ id: 'b' }, { id: 'a' }] }, wb: {} } } }
    const next = applyPatch(patch, { models, patch: parts.patch })
    const written = await writeProfile(next)
    const after = await readPatch(written)
    expect(collect(after, await readManifest(written)).models).toEqual(models)
    const rows = after.rows.filter(row => row.key === `id:${MODELS_ID}`)
    expect(rows[2]?.value).not.toHaveProperty('config')
    expect(rows[3]?.value.config).toEqual({ untouched: true })
    expect(rows[4]?.value.insert).toEqual([{ id: 'local-only', name: 'local-plugin' }])
    expect(next).toContain('disabled: false # local switch')
    expect(applyPatch(after, { models, patch: parts.patch })).toBe(next)
  })

  it('removes all applicable model rows so an older catalog cannot reappear', async () => {
    const paths = await writeProfile(`${SAMPLE_PATCH}
- id: llm-pi-ai
  config: {}
- id: llm-pi-ai
  disabled: true
  inject: { local: required }
- id: llm-pi-ai
  name: some-other-adapter
  config: { untouched: true }
`)
    const next = applyPatch(await readPatch(paths), { models: null })
    const written = await writeProfile(next)
    const after = await readPatch(written)
    expect(collect(after, await readManifest(written))).not.toHaveProperty('models')
    expect(after.rows.filter(row => row.key === `id:${MODELS_ID}`).map(row => row.value)).toEqual([
      { id: MODELS_ID, name: 'some-other-adapter', config: { untouched: true } },
    ])
    expect(next).not.toContain('disabled: true')
    expect(next).not.toContain('local: required')
    expect(next).toContain('id: agent-default-model')
  })

  it('leaves the file byte-identical when only the objects are new', async () => {
    const paths = await writeProfile()
    const patch = await readPatch(paths)
    const parts = collect(patch, await readManifest(paths))
    const config = (parts.models as { config: Record<string, unknown> }).config
    // The same catalog, built fresh: same routes, same order, new objects.
    const same = { ...config, providers: { ...(config.providers as Record<string, unknown>) } }
    expect(applyPatch(patch, { models: { config: same } })).toBe(patch.text)
  })

  it('moves a provider together with the comment above it', async () => {
    const paths = await writeProfile(SAMPLE_PATCH.replace('      wb:\n', '      # 备用线路\n      wb:\n'))
    const patch = await readPatch(paths)
    const parts = collect(patch, await readManifest(paths))
    const config = (parts.models as { config: { providers: Record<string, unknown> } }).config
    const reversed = { ...config, providers: Object.fromEntries(Object.entries(config.providers).reverse()) }

    const next = applyPatch(patch, { models: { config: reversed } })

    expect(next.indexOf('# 备用线路')).toBeLessThan(next.indexOf('      wb:'))
    expect(next.indexOf('      wb:')).toBeLessThan(next.indexOf('      free:'))
    expect(next).toContain('displayName: 歪比巴布')
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

describe('the layer DSH reads the catalog from', () => {
  /** A home patch carrying the same two providers, in the other order. */
  const HOME_PATCH = `- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      wb: # moved up on this machine
        displayName: 歪比巴布
      free:
        displayName: 免费
`

  /** A profile plus a home patch beside it, as a machine that edited one has. */
  async function withHome(text: string): Promise<ResolvedPaths> {
    const paths = await writeProfile(SAMPLE_PATCH)
    const home = await tempDir('dsh-home-')
    await writeFile(join(home, 'cordis.patch.yml'), text, 'utf8')
    paths.homePatchFile = join(home, 'cordis.patch.yml')
    return paths
  }

  it('is the profile patch when the machine has no home layer', async () => {
    const paths = await writeProfile(SAMPLE_PATCH)
    // No home directory known at all is the same answer, and the one a test
    // profile has to keep getting: never read, never write ~/.dsh.
    expect(await readHomePatch(paths)).toBeUndefined()
    const profile = await readPatch(paths)
    expect(modelsLayer(profile, undefined)).toBe(profile)
  })

  it('is the home patch when its model row carries a config', async () => {
    const paths = await withHome(HOME_PATCH)
    const profile = await readPatch(paths)
    const home = await readHomePatch(paths)
    expect(home).toBeDefined()
    // Loader composes the home layer last and replaces `config` wholesale, so this
    // is the catalog DSH actually lists.
    expect(modelsLayer(profile, home)).toBe(home)
  })

  it('stays the profile patch when the home row only changes metadata', async () => {
    const paths = await withHome(`- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  disabled: false
`)
    const profile = await readPatch(paths)
    const home = await readHomePatch(paths)
    // A row with no `config` hides nothing, here as in `collect`.
    expect(modelsLayer(profile, home)).toBe(profile)
  })

  it('takes the catalog from the home layer and the other rows from the profile', async () => {
    const paths = await withHome(HOME_PATCH)
    const profile = await readPatch(paths)
    const home = await readHomePatch(paths)
    const parts = collect(profile, await readManifest(paths), modelsLayer(profile, home))

    const config = parts.models?.config as { providers: Record<string, unknown> }
    expect(Object.keys(config.providers)).toEqual(['wb', 'free'])
    // The rows that are not the catalog are still the profile's own.
    const ids = (parts.patch?.entries ?? []).map(entry => entry['id'])
    expect(ids).toContain('permission')
    expect(ids).not.toContain(MODELS_ID)
  })

  it('writes a catalog into the home patch and leaves its other rows alone', async () => {
    const paths = await withHome(HOME_PATCH)
    const home = await readHomePatch(paths)
    const next = applyPatch(home!, { models: { config: { providers: { free: { displayName: '免费' }, wb: {} } } } })
    expect(next.indexOf('      free:')).toBeLessThan(next.indexOf('      wb:'))
    expect(next).toContain('# moved up on this machine')
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
