/** Host route/timer tests must never fall back to this machine's real DSH home. */
import { join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import { cleanUp, tempDir } from './harness.ts'

beforeEach(async () => {
  const home = await tempDir('test-only-dsh-home-')
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('DSH_PROFILE_DIR', join(home, 'profiles', 'test'))
  vi.stubEnv('DSH_PROFILE', 'test')
})
afterEach(async () => { vi.unstubAllEnvs(); await cleanUp() })
