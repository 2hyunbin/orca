import { expect, it, vi } from 'vitest'
import { ProfileStateWriterError } from '../profile-state/profile-state-writer-errors'
import {
  createSqliteMaintenanceFixture,
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from './profile-state-maintenance-fixture'

export function registerDurableMutationFinalizationTests(): void {
  it.each(['known-failure', 'indeterminate', 'success'] as const)(
    'preserves synchronous authority publication on %s',
    async (outcome) => {
      const { store, authority } = createSqliteMaintenanceFixture()
      store.flushOrThrow()
      const before = JSON.parse(authority.readSerializedState() ?? '{}')
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const published: unknown[] = []
      store.onWorkspaceSessionWritten((host) => {
        published.push([host, store.getWorkspaceSession().activeTabId])
      })
      const write = authority.writeCompleteSerializedDomains.bind(authority)
      const failure = new ProfileStateWriterError(
        'sync-test',
        'disk refused',
        outcome === 'indeterminate' ? 'indeterminate' : 'known-failure'
      )
      vi.spyOn(authority, 'writeCompleteSerializedDomains').mockImplementationOnce((domains) => {
        expect(published).toEqual([[null, 'B']])
        store.getWorkspaceSession().activeTabId = 'C'
        if (outcome !== 'success') {
          throw failure
        }
        write(domains)
      })
      const pending = store.runDurableMutation(() => {
        store.getWorkspaceSession().activeTabId = 'B'
        return { value: true }
      })
      await (outcome === 'success'
        ? expect(pending).resolves.toBe(true)
        : expect(pending).rejects.toBe(failure))
      expect(published).toEqual(
        outcome === 'known-failure'
          ? [
              [null, 'B'],
              [null, 'C']
            ]
          : [[null, 'B']]
      )
      expect(store.getWorkspaceSession().activeTabId).toBe('C')
      expect(JSON.parse(authority.readSerializedState() ?? '{}').workspaceSession.activeTabId).toBe(
        outcome === 'success' ? 'B' : before.workspaceSession.activeTabId
      )
      if (outcome === 'known-failure') {
        await store.runDurableMutation(() => ({ value: undefined, persist: 'if-dirty' }))
        expect(
          JSON.parse(authority.readSerializedState() ?? '{}').workspaceSession.activeTabId
        ).toBe('C')
      }
    }
  )

  it.each(['maintenance', 'freeze', 'final'] as const)(
    'publishes a failed no-rollback mutation before %s closes its authority',
    async (kind) => {
      const { store, authority, readState } = await createWorkerMaintenanceFixture()
      const before = readState()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const started = maintenanceBarrier()
      const release = maintenanceBarrier()
      const failure = new Error('disk refused')
      vi.spyOn(authority, 'writeCompleteSerializedDomains').mockImplementationOnce(async () => {
        started.resolve()
        await release.promise
        throw failure
      })
      const close = vi.spyOn(authority, 'close')
      const published: unknown[] = []
      const unsubscribe = store.onWorkspaceSessionWritten((host) => {
        const session = store.getWorkspaceSession()
        published.push([host, session.activeTabId])
        expect(close).not.toHaveBeenCalled()
        if (session.activeTabId === 'C') {
          // Failure observers run outside callback admission, including without a rollback.
          expect(() => store.setWorkspaceSession(session)).toThrow(
            'blocking new terminal snapshot work'
          )
        }
      })
      const pending = store.runDurableMutation(() => {
        store.getWorkspaceSession().activeTabId = 'B'
        return { value: undefined }
      })
      const rejected = expect(pending).rejects.toBe(failure)
      await started.promise
      store.getWorkspaceSession().activeTabId = 'C'
      const stopping =
        kind === 'maintenance'
          ? store.beginProfileMaintenance()
          : kind === 'freeze'
            ? store.freezeWritesAsync()
            : store.flushFinalOrThrowAsync()
      await expect(store.runDurableMutation(() => ({ value: undefined }))).rejects.toThrow(
        'finalized'
      )
      expect(close).not.toHaveBeenCalled()
      release.resolve()
      await rejected
      const maintenance = await stopping
      expect(published).toEqual([
        [null, 'B'],
        [null, 'C']
      ])
      expect(close).toHaveBeenCalledOnce()
      expect(store.getWorkspaceSession().activeTabId).toBe('C')
      expect(readState().workspaceSession.activeTabId).toBe(
        kind === 'freeze' ? before.workspaceSession.activeTabId : 'C'
      )
      expect(() => store.setWorkspaceSession(store.getWorkspaceSession())).toThrow(
        'blocking new terminal snapshot work'
      )
      unsubscribe()
      if (maintenance) {
        await maintenance.resume()
      }
    }
  )
}
