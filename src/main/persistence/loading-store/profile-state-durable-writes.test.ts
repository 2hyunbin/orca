import { fixture } from './profile-state-delayed-authority-fixture'
import { describe, expect, it, vi } from 'vitest'
import { registerProfileStateWorkerCoordinationTests } from './profile-state-worker-coordination.spec'
import { registerProfileStateWorkerSecretRetentionTests } from './profile-state-worker-secret-retention.spec'
import { registerProfileStateWriteBatchingTests } from './profile-state-write-batching.spec'
import { registerPtyBindingAsyncDurabilityTests } from './pty-binding-async-durability.spec'
import { registerPtyBindingCreatedSurfaceRollbackTests } from './pty-binding-created-surface-rollback.spec'
import { registerPtyBindingRestartRetirementTests } from './pty-binding-restart-retirement.spec'
import { registerPtyRetirementAsyncDurabilityTests } from './pty-retirement-async-durability.spec'
import { registerWorkspaceSessionWriteListenersTests } from './workspace-session-write-listeners.spec'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

describe('profile-state-worker-coordination', registerProfileStateWorkerCoordinationTests)
describe('profile-state-worker-secret-retention', registerProfileStateWorkerSecretRetentionTests)
describe('profile-state-write-batching', registerProfileStateWriteBatchingTests)
describe('pty-binding-async-durability', registerPtyBindingAsyncDurabilityTests)
describe('pty-binding-created-surface-rollback', registerPtyBindingCreatedSurfaceRollbackTests)
describe('pty-binding-restart-retirement', registerPtyBindingRestartRetirementTests)
describe('pty-retirement-async-durability', registerPtyRetirementAsyncDurabilityTests)
describe('workspace-session-write-listeners', registerWorkspaceSessionWriteListenersTests)

it('derives inside unscheduled durable edits and republishes rollback before observers read', async () => {
  const { store, authority, readState } = await fixture()
  const snapshot = store.getLineageSnapshot()
  const seen: object[] = []
  store.onWorkspaceSessionWritten(() => seen.push(store.getLineageSnapshot()))
  authority.failNextWrite()
  const mutation = store.runDurableMutation(() => {
    store.getWorkspaceSession().activeTabId = 'temporary'
    expect(store.getLineageSnapshot()).not.toBe(snapshot)
    expect(store.getLineageSnapshot()).not.toBe(store.getLineageSnapshot())
    return {
      value: undefined,
      rollback: () => {
        store.getWorkspaceSession().activeTabId = null
      }
    }
  })
  await expect(mutation).rejects.toThrow('profile_state_write_failed')
  expect(seen).toHaveLength(2)
  expect(seen[0]).not.toBe(seen[1])
  expect(store.getLineageSnapshot()).toBe(seen[1])
  expect(readState()).not.toHaveProperty('lineageSnapshot')
  expect(authority.captures.flat().some((row) => row.domain === 'lineageSnapshot')).toBe(false)
  await store.runDurableMutation(() => ({ value: store.getLineageSnapshot(), persist: false }))
  expect(store.getLineageSnapshot()).not.toBe(seen[1])
})
