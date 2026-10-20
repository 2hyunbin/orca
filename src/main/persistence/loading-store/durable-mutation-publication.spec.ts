import { expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { ProfileStateWriterError } from '../profile-state/profile-state-writer-errors'
import { fixture } from './profile-state-delayed-authority-fixture'

export function registerDurableMutationPublicationTests(): void {
  const hosts = ['local', 'ssh:publication-target', 'runtime:publication-environment'] as const
  const folder = 'folder-project::/fixture/folder::workspace:00000000-0000-4000-8000-000000000001'
  const sibling = 'folder-project::/fixture/folder::workspace:00000000-0000-4000-8000-000000000002'

  it.each(['known-failure', 'indeterminate', 'success'] as const)(
    'publishes current memory independently of rollback on %s',
    async (outcome) => {
      const { store, authority, readState } = await fixture()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      for (const host of hosts) {
        store.patchWorkspaceSession({ activeTabId: 'A', activeWorktreeId: sibling }, host)
      }
      await store.flushPendingOrThrowAsync()
      authority.captures.length = 0
      for (const host of hosts) {
        store.patchWorkspaceSession({ activeTabId: 'B', activeWorktreeId: folder }, host)
      }
      const publications: { listener: number; host: ExecutionHostId | null; tabs: unknown[] }[] = []
      for (const listener of [1, 2]) {
        store.onWorkspaceSessionWritten((host) => {
          publications.push({
            listener,
            host,
            tabs: hosts.map((id) => store.getWorkspaceSession(id).activeTabId)
          })
        })
      }
      const initial = [1, 2].map((listener) => ({ listener, host: null, tabs: ['B', 'B', 'B'] }))
      const write = authority.writeSerializedDomains.bind(authority)
      vi.spyOn(authority, 'writeSerializedDomains').mockImplementationOnce((domains) => {
        expect(publications).toEqual(initial)
        return write(domains)
      })
      const gate = authority.pause()
      let settled = false
      // A dirty semantic match has no state to restore; it still needs a durable receipt.
      const pending = store
        .runDurableMutation(() => ({ value: true }))
        .finally(() => {
          settled = true
        })
      const failure = new ProfileStateWriterError(
        'publication-test',
        'write refused',
        outcome === 'indeterminate' ? 'indeterminate' : 'known-failure'
      )
      const result =
        outcome === 'success'
          ? expect(pending).resolves.toBe(true)
          : expect(pending).rejects.toBe(failure)
      try {
        await gate.started.promise
        expect(settled).toBe(false)
        expect(publications).toEqual(initial)
        expect(authority.captures).toHaveLength(1)
        expect(authority.captures[0]).toContainEqual({
          domain: 'workspaceSession',
          payload: expect.stringContaining('"activeTabId":"B"')
        })
        expect(readState().workspaceSession.activeTabId).toBe('A')
        for (const host of hosts) {
          store.getWorkspaceSession(host).activeTabId = 'C'
        }
        store.updateSettings({ theme: 'dark' })
        if (outcome === 'success') {
          gate.finish.resolve()
        } else {
          gate.finish.reject(failure)
        }
        await result
      } finally {
        gate.finish.resolve()
      }
      expect(hosts.map((host) => store.getWorkspaceSession(host).activeTabId)).toEqual([
        'C',
        'C',
        'C'
      ])
      expect(hosts.map((host) => store.getWorkspaceSession(host).activeWorktreeId)).toEqual([
        folder,
        folder,
        folder
      ])
      expect(publications).toEqual(
        outcome === 'known-failure'
          ? [
              ...initial,
              ...[1, 2].map((listener) => ({ listener, host: null, tabs: ['C', 'C', 'C'] }))
            ]
          : initial
      )
      expect(readState().workspaceSession.activeTabId).toBe(outcome === 'success' ? 'B' : 'A')

      if (outcome === 'known-failure') {
        // A selective retry must retain both failed domains and edits tracked during the wait.
        await store.runDurableMutation(() => ({ value: undefined, persist: 'if-dirty' }))
        expect(authority.captures).toHaveLength(2)
        const saved = readState()
        expect(saved.settings.theme).toBe('dark')
        expect(saved.workspaceSession).toMatchObject({ activeTabId: 'C', activeWorktreeId: folder })
        for (const host of hosts.slice(1)) {
          expect(saved.workspaceSessionsByHostId[host]).toMatchObject({
            activeTabId: 'C',
            activeWorktreeId: folder
          })
        }
        store.patchWorkspaceSession({ activeTabId: 'later-tracked' })
        store.updateSettings({ theme: 'light' })
        await store.flushPendingOrThrowAsync()
        expect(readState()).toMatchObject({
          settings: { theme: 'light' },
          workspaceSession: { activeTabId: 'later-tracked' }
        })
      }
    }
  )

  it.each([false, 'if-dirty'] as const)(
    'publishes once and does no restoration or disk work for persist: %s',
    async (persist) => {
      const { store, authority } = await fixture()
      const revision = authority.inner.revision
      const rollback = vi.fn(() => {
        throw new Error('must not restore a no-op')
      })
      const published = vi.fn()
      store.onWorkspaceSessionWritten(published)
      const revisionCheck = vi.spyOn(authority, 'assertCurrentRevision')
      await expect(
        store.runDurableMutation(() => ({ value: 'no-write', persist, rollback }))
      ).resolves.toBe('no-write')
      expect(published.mock.calls).toEqual([[null]])
      expect(rollback).not.toHaveBeenCalled()
      expect(authority.captures).toEqual([])
      expect(revisionCheck).not.toHaveBeenCalled()
      expect(authority.inner.revision).toBe(revision)
    }
  )

  it.each(['known-failure', 'indeterminate'] as const)(
    'preserves real rollback publication order on %s',
    async (outcome) => {
      const { store, authority } = await fixture()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const before = structuredClone(store.getWorkspaceSession())
      const published: unknown[] = []
      store.onWorkspaceSessionWritten((host) => {
        published.push([host, store.getWorkspaceSession().activeTabId])
      })
      const gate = authority.pause()
      const rollback = vi.fn(() => store.setWorkspaceSession(before))
      const pending = store.runDurableMutation(() => {
        store.getWorkspaceSession().activeTabId = 'B'
        return { value: true, rollback }
      })
      const failure = new ProfileStateWriterError('rollback-test', 'disk refused', outcome)
      const rejected = expect(pending).rejects.toBe(failure)
      try {
        await gate.started.promise
        store.getWorkspaceSession().activeTabId = 'C'
        gate.finish.reject(failure)
        await rejected
      } finally {
        gate.finish.resolve()
      }
      expect(rollback).toHaveBeenCalledTimes(outcome === 'known-failure' ? 1 : 0)
      expect(published).toEqual(
        outcome === 'known-failure'
          ? [
              [null, 'B'],
              ['local', before.activeTabId],
              [null, before.activeTabId]
            ]
          : [[null, 'B']]
      )
      expect(store.getWorkspaceSession()).toEqual(
        outcome === 'known-failure' ? before : { ...before, activeTabId: 'C' }
      )
    }
  )

  it.each(['mutation', 'listener'] as const)(
    'publishes partial memory and stops saving after an initial %s throws',
    async (throws) => {
      const { store, authority, readState } = await fixture()
      const before = readState()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const failure = new Error('initial callback failed')
      const published = vi.fn(() => {
        expect(store.getWorkspaceSession().activeTabId).toBe('B')
        if (throws === 'listener') {
          throw failure
        }
      })
      store.onWorkspaceSessionWritten(published)
      await expect(
        store.runDurableMutation(() => {
          store.getWorkspaceSession().activeTabId = 'B'
          if (throws === 'mutation') {
            throw failure
          }
          return { value: undefined }
        })
      ).rejects.toBe(failure)
      expect(published.mock.calls).toEqual([[null]])
      expect(authority.captures).toEqual([])
      expect(authority.close).toHaveBeenCalledOnce()
      await expect(store.flushFinalOrThrowAsync()).rejects.toBe(failure)
      expect(readState()).toEqual(before)
    }
  )

  it.each(['rollback', 'listener', 'both'] as const)(
    'stops saving after a throwing failure %s',
    async (throws) => {
      const { store, authority, readState } = await fixture()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const before = readState()
      const rollbackFailure = new Error('rollback failed')
      const listenerFailure = new Error('failure publication failed')
      const first = vi.fn(() => {
        if (store.getWorkspaceSession().activeTabId === 'C' && throws !== 'rollback') {
          throw listenerFailure
        }
      })
      const second = vi.fn()
      store.onWorkspaceSessionWritten(first)
      store.onWorkspaceSessionWritten(second)
      const gate = authority.pause()
      const rollback =
        throws === 'listener'
          ? undefined
          : () => {
              throw rollbackFailure
            }
      const pending = store.runDurableMutation(() => {
        store.getWorkspaceSession().activeTabId = 'B'
        return { value: undefined, rollback }
      })
      const expected = throws === 'rollback' ? rollbackFailure : listenerFailure
      const rejected = expect(pending).rejects.toBe(expected)
      try {
        await gate.started.promise
        store.getWorkspaceSession().activeTabId = 'C'
        gate.finish.reject(new Error('disk refused'))
        await rejected
      } finally {
        gate.finish.resolve()
      }
      expect(first).toHaveBeenCalledTimes(2)
      expect(second).toHaveBeenCalledTimes(throws === 'rollback' ? 2 : 1)
      expect(authority.close).toHaveBeenCalledOnce()
      expect(store.getWorkspaceSession().activeTabId).toBe('C')
      await expect(store.runDurableMutation(() => ({ value: undefined }))).rejects.toThrow(
        'finalized'
      )
      await expect(store.flushFinalOrThrowAsync()).rejects.toBe(expected)
      expect(readState()).toEqual(before)
    }
  )
}
