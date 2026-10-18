import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import {
  mutateStoppedProfileState,
  readPersistedProfileState
} from './helpers/persisted-profile-state'
import { SIDEBAR_INPUTS_BUILD } from './helpers/sidebar-shadow'
import { waitForSessionReady } from './helpers/store'

test.skip(
  !SIDEBAR_INPUTS_BUILD,
  'the host stamps sort keys only in an ORCA_SIDEBAR_INPUTS=main build'
)

function storedTiers(userDataDir: string, ids: readonly string[]): Record<string, unknown> {
  const meta = readPersistedProfileState(userDataDir).worktreeMeta
  const rows = meta && typeof meta === 'object' ? Object.entries(meta) : []
  return Object.fromEntries(
    rows
      .filter(([id]) => ids.includes(id))
      .map(([id, row]) => [
        id,
        row && typeof row === 'object' && 'smartTier' in row ? row.smartTier : undefined
      ])
  )
}

test('a restart clears a tier no agent backs any more, and keeps an SSH host’s', async (// oxlint-disable-next-line no-empty-pattern -- This exercise owns its app launch.
{}, testInfo) => {
  test.setTimeout(3 * 60_000)
  test.skip(!existsSync(TEST_REPO_PATH_FILE), 'Global setup did not produce a seeded test repo')
  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null
  try {
    const first = await session.launch()
    await waitForSessionReady(first.page)
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    const localId = await first.page.evaluate(async (path) => {
      const result = await window.api.repos.add({ path })
      if ('error' in result) {
        throw new Error(result.error)
      }
      return `${result.repo.id}::${path}`
    }, repoPath)
    const sshId = `${localId.split('::')[0]}::/srv/stamps-remote`
    const ids = [localId, sshId]
    await session.close(first.app)
    mutateStoppedProfileState(session.userDataDir, (state) => {
      const existing =
        state.worktreeMeta && typeof state.worktreeMeta === 'object' ? state.worktreeMeta : {}
      // Recent, so the metadata collector keeps an entry whose repo this profile never had.
      const row = {
        displayName: 'stamps',
        lastActivityAt: Date.now(),
        smartTier: 'working',
        smartAt: 4
      }
      state.worktreeMeta = {
        ...existing,
        [localId]: { ...row, instanceId: 'stamps-local' },
        [sshId]: { ...row, instanceId: 'stamps-remote', hostId: 'ssh:unreachable' }
      }
    })
    expect(storedTiers(session.userDataDir, ids)).toEqual({
      [localId]: 'working',
      [sshId]: 'working'
    })

    const second = await session.launch()
    app = second.app
    await waitForSessionReady(second.page)
    await session.close(app)
    app = null
    // The local agent left no hook row and no terminal; the unreached SSH host is not evidence.
    expect(storedTiers(session.userDataDir, ids)).toEqual({
      [localId]: undefined,
      [sshId]: 'working'
    })
  } finally {
    await session.dispose(app ?? undefined)
  }
})
