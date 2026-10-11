import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../../persistence/loading-store/store'
import { ProfileStateSqliteAuthority } from '../../persistence/profile-state/profile-state-sqlite-authority'
import { OrcaRuntimeService } from '../orca-runtime'
import type { RuntimeStore } from '../runtime-store-contract'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests
} from '../../worktree-background-removal'
import { failedWorktreeRemovals, pendingWorktreeRemovals } from '../../worktree-removal-table'
import type { WorktreeRemovalRecord } from '../../worktree-removal-records'

class RemovalRuntime extends OrcaRuntimeService {
  readonly helperFailure = new Error('runtime helper override')
  stopAtHelper = false
  readonly purges: {
    store: RuntimeStore
    worktreeId: string
    repoId: string
    hostId?: ExecutionHostId
  }[] = []

  protected override localRemovalJobHost(store: RuntimeStore) {
    if (this.stopAtHelper) {
      throw this.helperFailure
    }
    return super.localRemovalJobHost(store)
  }

  protected override purgeRemovedWorktree(
    store: RuntimeStore,
    worktreeId: string,
    repoId: string,
    hostId?: ExecutionHostId
  ): void {
    this.purges.push({ store, worktreeId, repoId, hostId })
  }

  recoveryJobHost(store: RuntimeStore) {
    return this.workspaceRemovalRecovery.localRemovalJobHost(store)
  }

  retryRemoval(record: WorktreeRemovalRecord): boolean {
    return this.retryFailedLocalRemoval(
      { kind: 'local' },
      { id: record.worktreeId, path: record.worktreePath },
      [],
      {}
    )
  }
}

let directory: string
let store: Store
let runtime: RemovalRuntime
let record: WorktreeRemovalRecord

beforeEach(() => {
  _resetPendingWorktreeRemovalsForTests()
  directory = mkdtempSync(join(tmpdir(), 'orca-removal-reentry-'))
  store = new Store({
    dataFile: join(directory, 'state.json'),
    profileStateAuthority: new ProfileStateSqliteAuthority(join(directory, 'profile.db'), 'reentry')
  })
  runtime = new RemovalRuntime(store)
  record = {
    worktreeId: `repo::${join(directory, 'checkout')}`,
    repoId: 'repo',
    repoPath: directory,
    worktreePath: join(directory, 'checkout'),
    branch: 'feature',
    head: '',
    deleteBranch: false,
    force: false,
    requestedAt: Date.now()
  }
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  await _settlePendingWorktreeRemovalsForTests()
  _resetPendingWorktreeRemovalsForTests()
  store.freezeWrites()
  rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

it('retains the protected runtime purge dispatch in a recovery job', () => {
  runtime.recoveryJobHost(store).purge(record)
  expect(runtime.purges).toEqual([
    { store, worktreeId: record.worktreeId, repoId: record.repoId, hostId: 'local' }
  ])
})

it('uses the runtime helper override before resuming an interrupted removal', () => {
  runtime.stopAtHelper = true
  pendingWorktreeRemovals.set(record.worktreeId, record)
  expect(() => runtime.finishInterruptedWorktreeRemovals()).toThrow(runtime.helperFailure)
})

it('uses the runtime helper override before retrying a failed removal', () => {
  runtime.stopAtHelper = true
  failedWorktreeRemovals.set(record.worktreeId, record)
  expect(() => runtime.retryRemoval(record)).toThrow(runtime.helperFailure)
})

it('captures the watcher callback and retains its job-host call receiver', async () => {
  const calls: { receiver: unknown; path: string }[] = []
  runtime.acquireFileWatcherRemoval = async function (this: unknown, path: string) {
    calls.push({ receiver: this, path })
    return { finish: async () => {} }
  }
  const captured = runtime.acquireFileWatcherRemoval
  const host = runtime.recoveryJobHost(store)
  runtime.acquireFileWatcherRemoval = async () => {
    throw new Error('replacement callback')
  }
  await host.acquireWatcherRemoval(record.worktreePath)
  expect(host.acquireWatcherRemoval).toBe(captured)
  expect(calls).toEqual([{ receiver: host, path: record.worktreePath }])
})
