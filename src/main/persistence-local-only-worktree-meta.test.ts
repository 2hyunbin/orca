import { closeTestStores, createStore, testState } from './persistence-test-harness'
/**
 * The floating and setup terminals have no repo row, so their metadata belongs to this store's own
 * machine. An older build left them unstamped, which projected them onto every SSH host (#31498).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultPersistedState } from '../shared/constants'
import { hostWorktreeTarget } from '../shared/worktree/host-qualified-identity'
import { resolveWorktreeMetaOwner } from './persistence/host-qualified-worktree-meta'
import { collectDependentStateBlockers } from './ssh/targets/ssh-target-orcad-dependents'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const SSH_HOST = 'ssh:ssh-1'

function createUpgradedStore() {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(
    join(testState.dir, 'orca-data.json'),
    JSON.stringify({
      ...getDefaultPersistedState(testState.dir),
      worktreeMeta: {
        [FLOATING_TERMINAL_WORKTREE_ID]: {
          instanceId: '11111111-1111-4111-8111-111111111111',
          displayName: '',
          comment: '',
          isUnread: false,
          sortOrder: 1,
          lastActivityAt: 1,
          workspaceStatus: 'in-progress'
        }
      }
    }),
    'utf-8'
  )
  return createStore()
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-local-only-worktree-meta-'))
})

afterEach(async () => {
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('local-only workspace metadata', () => {
  it('stamps a pre-existing unstamped floating terminal row local on load', () => {
    const store = createUpgradedStore()
    expect(store.getWorktreeMeta(FLOATING_TERMINAL_WORKTREE_ID)?.hostId).toBe('local')
    expect(store.getAllWorktreeMetaForHost(SSH_HOST)).not.toHaveProperty(
      FLOATING_TERMINAL_WORKTREE_ID
    )
    expect(store.getWorktreeMetaForHost(FLOATING_TERMINAL_WORKTREE_ID, 'local')?.sortOrder).toBe(1)
    expect(collectDependentStateBlockers(store, 'ssh-1')).toEqual([])
  })

  it('lands every floating terminal write on this machine, whichever host the caller named', () => {
    const store = createUpgradedStore()
    expect(resolveWorktreeMetaOwner(store, FLOATING_TERMINAL_WORKTREE_ID)?.hostId).toBe('local')
    store.setWorktreeMeta(
      hostWorktreeTarget({ id: FLOATING_TERMINAL_WORKTREE_ID, hostId: SSH_HOST }),
      {
        isUnread: true
      }
    )
    expect(store.getAllWorktreeMetaForHost('local')[FLOATING_TERMINAL_WORKTREE_ID]).toMatchObject({
      hostId: 'local',
      isUnread: true
    })
    expect(store.getAllWorktreeMetaForHost(SSH_HOST)).toEqual({})
    expect(collectDependentStateBlockers(store, 'ssh-1')).toEqual([])
  })
})
