import { describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import { managedServerUpdateDeps } from './managed-server-update-deps'

vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getVersion: () => '1.4.300' })
}))
vi.mock('./orcad-managed-runtime-context', () => ({
  requireManagedOrcadTargetStore: () => ({ updateTarget: vi.fn() })
}))

const target = (id: string): SshTarget => ({ id, label: id, host: id, port: 22, username: 'me' })

describe('retrying a recorded managed-server update failure', () => {
  it('retries until an update actually fails during this launch', () => {
    const deps = managedServerUpdateDeps('/tmp/user-data')
    // A deferral or skip records nothing, so the retry stays available.
    expect(deps.retryRecordedFailure(target('a'))).toBe(true)
    expect(deps.retryRecordedFailure(target('a'))).toBe(true)
    deps.recordUpdateFailure(target('a'), 'candidate rejected')
    // Deps are rebuilt per connect; the launch's memory is not.
    expect(managedServerUpdateDeps('/tmp/user-data').retryRecordedFailure(target('a'))).toBe(false)
    expect(deps.retryRecordedFailure(target('b'))).toBe(true)
  })

  it('counts a failure this launch as the launch’s attempt', () => {
    const deps = managedServerUpdateDeps('/tmp/user-data')
    deps.recordUpdateFailure(target('c'), 'candidate rejected')
    expect(deps.retryRecordedFailure(target('c'))).toBe(false)
  })
})
