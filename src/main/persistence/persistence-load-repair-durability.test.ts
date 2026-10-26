import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  readDataFile
} from './persistence-test-harness'
// Settle unrelated migrations first; only a debounced save proves the repair marked its own state dirty.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../../shared/persisted-state-types'

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))
const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => false
  }
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

async function settledProfile(): Promise<PersistedState> {
  writeDataFile({
    schemaVersion: 1,
    repos: [],
    worktreeMeta: {},
    settings: {},
    ui: {},
    githubCache: { pr: {}, issue: {} },
    workspaceSession: {}
  })
  const store = await createStore()
  store.flush()
  return readDataFile() as PersistedState
}

async function reloadAndSettleWrites(): Promise<PersistedState> {
  vi.useFakeTimers()
  try {
    const store = await createStore()
    vi.advanceTimersByTime(5000)
    await store.waitForPendingWrite()
  } finally {
    vi.useRealTimers()
  }
  return readDataFile() as PersistedState
}

describe('load-time normalization durability', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('lifts owned global/repo action recipes through actual flush, close and reopen on an already typed profile', async () => {
    const settled = await settledProfile()
    await closeTestStores()
    const literal = '  --yolo  --search '
    const conflict = {
      agentId: 'claude',
      agentArgs: ' --dangerously-skip-permissions ',
      launchPreferences: { agentId: 'claude', permissionMode: 'ask' }
    } as const
    settled.settings.agentPermissionDefault = 'own'
    const source = settled.settings.sourceControlAi
    if (!source) {
      throw new Error('Missing settled Source Control settings')
    }
    settled.settings.sourceControlAi = {
      ...source,
      actions: {
        fixChecks: {
          agentId: 'claude',
          agentArgs: '--dangerously-skip-permissions --verbose',
          launchPreferences: { agentId: 'claude', model: 'sonnet', options: { effort: 'high' } }
        },
        resolveComments: { agentId: 'codex', agentArgs: literal },
        fixPushFailure: { agentArgs: ' --dangerously-skip-permissions ' },
        fixCommitFailure: conflict,
        commitMessage: { agentId: 'claude', agentArgs: '--dangerously-skip-permissions' }
      }
    }
    settled.repos = [
      {
        id: 'recipe-repo',
        name: 'recipe',
        path: '/tmp/recipe',
        worktreesPath: '/tmp',
        sourceControlAi: {
          actionOverrides: {
            fixChecks: {
              agentId: 'codex',
              agentArgs: '--dangerously-bypass-approvals-and-sandbox'
            },
            resolveComments: { agentArgs: ' --dangerously-bypass-approvals-and-sandbox ' },
            fixPushFailure: { agentId: null, agentArgs: literal }
          }
        }
      }
    ]
    writeDataFile(settled)
    const store = createStore()
    expect(store.getSettings().sourceControlAi?.actions?.fixChecks).toMatchObject({
      agentArgs: '--verbose',
      launchPreferences: {
        agentId: 'claude',
        model: 'sonnet',
        options: { effort: 'high' },
        permissionMode: 'full-access'
      }
    })
    expect(store.getRepos()[0]?.sourceControlAi?.actionOverrides?.fixChecks).toEqual({
      agentId: 'codex',
      agentArgs: '',
      launchPreferences: { agentId: 'codex', permissionMode: 'full-access' }
    })
    store.flush()
    await closeTestStores()
    const reopened = createStore()
    const actions = reopened.getSettings().sourceControlAi?.actions
    expect(actions?.fixChecks?.launchPreferences?.permissionMode).toBe('full-access')
    expect(actions?.resolveComments?.agentArgs).toBe(literal)
    expect(actions?.fixPushFailure?.agentArgs).toBe(' --dangerously-skip-permissions ')
    expect(actions?.fixCommitFailure).toEqual(conflict)
    expect(actions?.commitMessage?.agentArgs).toBe('--dangerously-skip-permissions')
    const rows = reopened.getRepos()[0]?.sourceControlAi?.actionOverrides
    expect(rows?.fixChecks?.agentArgs).toBe('')
    expect(rows?.resolveComments).toEqual(
      settled.repos[0]?.sourceControlAi?.actionOverrides?.resolveComments
    )
    expect(rows?.fixPushFailure).toEqual(
      settled.repos[0]?.sourceControlAi?.actionOverrides?.fixPushFailure
    )
    const stable = readDataFile()
    reopened.flush()
    expect(readDataFile()).toEqual(stable)
  })

  it('persists the legacy search-tab explorer view repair', async () => {
    const settled = await settledProfile()
    delete (settled.ui as Record<string, unknown>).rightSidebarExplorerView
    settled.ui.rightSidebarTab = 'search'
    writeDataFile(settled)

    const persisted = await reloadAndSettleWrites()

    expect(persisted.ui.rightSidebarExplorerView).toBe('search')
  })

  it('persists a repaired notification settings block', async () => {
    const settled = await settledProfile()
    settled.settings.notifications = {
      ...settled.settings.notifications,
      enabled: 'false' as unknown as boolean
    }
    writeDataFile(settled)

    const persisted = await reloadAndSettleWrites()

    expect(persisted.settings.notifications.enabled).toBe(true)
  })
})
