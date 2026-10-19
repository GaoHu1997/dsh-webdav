/**
 * Test scaffolding: throwaway DSH profiles on the real filesystem.
 *
 * The host half reads and writes real files (`cordis.patch.yml`,
 * `package.json`) through the yaml Document API, and the only honest way to
 * check that comments, order and formatting survive a sync is to write to a
 * file and read it back. Every profile here is a `mkdtemp` directory, removed
 * best-effort afterwards, because a Windows file lock must never fail a suite.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, normaliseConfig } from '../src/state.ts'
import type { SyncConfig } from '../src/wire.ts'
import { pathsOf } from '../src/engine.ts'
import type { ResolvedPaths } from '../src/paths.ts'

/** Directories to remove after each test; failures here are swallowed. */
export const cleanup: string[] = []

/** Make a throwaway directory and remember it. */
export async function tempDir(prefix = 'dsh-webdav-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

/** Remove everything `tempDir` made. */
export async function cleanUp(): Promise<void> {
  while (cleanup.length > 0) {
    const dir = cleanup.pop()
    if (dir === undefined) continue
    await rm(dir, { recursive: true, force: true }).catch(() => {
      /* best-effort: Windows keeps handles open */
    })
  }
}

/** The patch a live profile looks like, comments and all. */
export const SAMPLE_PATCH = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries.

- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    transcriptView: standard
    performanceUsage: compact

- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: free # the local gateway
    model: group/auto-deepseek-v4-1-flash
    reasoningEffort: high

- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      free:
        displayName: 免费
        api: openai-responses
        baseURL: http://127.0.0.1:3425/v1
        apiKeyEnv: FREE_API_KEY
        models:
          - id: group/auto-deepseek-v4-1-flash
            name: Auto
            contextWindow: 131072
            maxTokens: 8192
            input: [text, image]
      wb:
        displayName: 歪比巴布
        api: openai-responses
        baseURL: https://www.waibibabo.com/v1
        apiKeyEnv: WB_API_KEY
        models:
          - id: gpt-6-astra
            name: Astra
            contextWindow: 262144
            maxTokens: 16384

- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    defaultPreset: danger-full-access

- insert:
    # magpie
    - id: magpie-mcp-context7
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: context7
        transport: streamable-http
        url: https://mcp.context7.com/mcp
`

/** The manifest a live profile looks like. */
export const SAMPLE_MANIFEST = `${JSON.stringify({
  name: 'dsh-profile-desktop',
  private: true,
  dependencies: {
    'billion-context': '0.1.197',
    'dsh-git-branch-manage': '^1.0.2',
  },
  dsh: {
    profile: {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'billion-context'],
    },
  },
}, null, 2)}\n`

/** Write a profile with the given patch and manifest text. */
export async function writeProfile(
  patch: string = SAMPLE_PATCH,
  manifest: string = SAMPLE_MANIFEST,
): Promise<ResolvedPaths> {
  const dir = await tempDir()
  await writeFile(join(dir, 'cordis.patch.yml'), patch, 'utf8')
  await writeFile(join(dir, 'package.json'), manifest, 'utf8')
  return pathsOf(dir)
}

/** A profile with no patch and no manifest at all (a machine that never ran dsh). */
export async function emptyProfile(): Promise<ResolvedPaths> {
  const dir = await tempDir()
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  return pathsOf(dir)
}

/** A stored configuration pointing at the fake server. */
export function configFor(over: Partial<SyncConfig> = {}): SyncConfig {
  return normaliseConfig({ ...defaultConfig(), url: 'https://dav.test/dav', passphrase: 'a passphrase', ...over })
}

/** Write a `node_modules` tree naming the given top-level packages. */
export async function fakeNodeModules(paths: ResolvedPaths, names: readonly string[]): Promise<void> {
  const root = join(paths.profileDir, 'node_modules')
  await mkdir(root, { recursive: true })
  for (const name of names) {
    await mkdir(join(root, name), { recursive: true })
  }
}

/** A promise that settles after the microtask queue drains. */
export function settle(): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, 0)
  })
}
