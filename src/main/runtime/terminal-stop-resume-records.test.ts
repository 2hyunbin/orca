import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { Store } from '../persistence/loading-store/store'
import type { DurableProfileStateMutation } from '../persistence/loading-store/store-runtime-state'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { OrcaRuntimeService } from './orca-runtime'
import { RuntimeMachineName } from './runtime-machine-name'

class ResumeRecordsRuntime extends OrcaRuntimeService {
  clearResumeRecords() {
    return this['clearWorktreeTerminalResumeRecords']('folder-proof', LOCAL_EXECUTION_HOST_ID, [
      'closed-tab'
    ])
  }
}

const directories: string[] = []
beforeEach(() => {
  vi.spyOn(RuntimeMachineName.prototype, 'start').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function persistedRuntime() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-stop-resume-'))
  directories.push(directory)
  const store = createSqliteTestStore(Store, { dataFile: join(directory, 'orca-data.json') })
  store.setWorkspaceSession({
    ...store.getWorkspaceSession(),
    terminalPtyIncarnationsByPaneKey: { 'closed-tab:left': 'incarnation-proof' }
  })
  store.flushOrThrow()
  return { store, runtime: new ResumeRecordsRuntime(store) }
}

function removeSessionReader(store: Store) {
  const original = store.getWorkspaceSession
  Object.defineProperty(store, 'getWorkspaceSession', { configurable: true, value: undefined })
  return () => {
    Object.defineProperty(store, 'getWorkspaceSession', { configurable: true, value: original })
  }
}

describe('terminal resume cleanup guarded Store accesses', () => {
  it('removes stale pane incarnations through the real durable Store callback', async () => {
    const { store, runtime } = persistedRuntime()
    expect(store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey).toEqual({
      'closed-tab:left': 'incarnation-proof'
    })
    await expect(runtime.clearResumeRecords()).resolves.toBeUndefined()
    expect(store.getWorkspaceSession().terminalPtyIncarnationsByPaneKey).toEqual({})
  })

  it('refuses a missing capability before the durable callback', async () => {
    const { store, runtime } = persistedRuntime()
    const durable = vi.spyOn(store, 'runDurableMutation')
    const restore = removeSessionReader(store)
    try {
      await expect(runtime.clearResumeRecords()).rejects.toThrow('workspace_session_unavailable')
      expect(durable).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('keeps the native failure when the capability disappears after the guard', async () => {
    const { store, runtime } = persistedRuntime()
    const original = store.runDurableMutation.bind(store)
    let restore: (() => void) | undefined
    vi.spyOn(store, 'runDurableMutation').mockImplementation(function <T>(
      mutate: () => DurableProfileStateMutation<T>
    ): Promise<T> {
      return original(() => {
        restore = removeSessionReader(store)
        return mutate()
      })
    })
    try {
      await expect(runtime.clearResumeRecords()).rejects.toThrow(TypeError)
    } finally {
      restore?.()
    }
  })

  it('keeps the native failure at the later rollback capability read', async () => {
    const { store, runtime } = persistedRuntime()
    let restore: (() => void) | undefined
    vi.spyOn(store, 'runDurableMutation').mockImplementation(async function <T>(
      mutate: () => DurableProfileStateMutation<T>
    ): Promise<T> {
      const mutation = mutate()
      expect(mutation.rollback).toBeTypeOf('function')
      restore = removeSessionReader(store)
      mutation.rollback?.()
      return mutation.value
    })
    try {
      await expect(runtime.clearResumeRecords()).rejects.toThrow(TypeError)
    } finally {
      restore?.()
    }
  })
})
