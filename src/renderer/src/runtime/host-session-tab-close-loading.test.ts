import type * as HostSessionTabSourceProjection from './host-session-tab-source-projection'
// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { WebSessionCloseIntentTicket } from './web-session-close-intent'

function frame(wt: string, version: number): RuntimeMobileSessionTabsResult {
  return {
    worktree: wt,
    publicationEpoch: 'epoch',
    snapshotVersion: version,
    activeGroupId: 'group',
    activeTabId: null,
    activeTabType: null,
    tabs: ['a', 'b', 'c'].map((id) => ({
      type: 'agent-session',
      id: `agent-session:${wt}-${id}`,
      sessionId: `${wt}-${id}`,
      title: `${id}-${version}`,
      agent: 'codex',
      isActive: false
    })),
    tabGroups: [
      {
        id: 'group',
        tabOrder: ['a', 'b', 'c'].map((id) => `agent-session:${wt}-${id}`),
        activeTabId: null
      }
    ]
  }
}

it.each(['reclose', 'repair', 'healthy', 'throw'] as const)(
  'fences the original ticket across lazy recovery loading: %s',
  async (scenario) => {
    vi.resetModules()
    let release: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const requested = vi.fn()
    const project = vi.fn<(ticket: WebSessionCloseIntentTicket) => void>()
    vi.doMock('./host-session-tab-source-projection', async (importOriginal) => {
      requested()
      await ready
      const actual = await importOriginal<typeof HostSessionTabSourceProjection>()
      project.mockImplementation((ticket) => {
        if (scenario === 'throw') {
          throw new Error('restore bookkeeping failed')
        }
        actual.reprojectHostSessionTabSource(ticket)
      })
      return { ...actual, reprojectHostSessionTabSource: project }
    })
    const { useAppStore } = await import('../store')
    const { settleHostSessionTabClose } = await import('./host-session-tab-close')
    const intent = await import('./web-session-close-intent')
    const revision = await import('./runtime-environment-revision')
    const { applyWebSessionTabsSnapshot } = await import('./web-session-tabs-sync/snapshot-api')
    const { applyWebSessionTabsStorePatch } = await import('./web-session-tabs-sync/store-patch')
    const { decideWebSessionTabsSnapshot } =
      await import('./web-session-tabs-sync/tracking-decisions')
    const { resetWebSessionTabsSnapshotFreshnessForTests } =
      await import('./web-session-tabs-sync/tracking-lifecycle')
    const initial = useAppStore.getState()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wt = `loading-${scenario}`
    const env = `env-${scenario}`
    const closedId = `agent-session:${wt}-b`
    const apply = (version: number): void => {
      const snapshot = frame(wt, version)
      const decision = decideWebSessionTabsSnapshot(snapshot, env)
      applyWebSessionTabsStorePatch(
        (state) => (decision.apply ? applyWebSessionTabsSnapshot(state, snapshot, env) : state),
        { frames: [{ environmentId: env, worktreeId: wt, source: snapshot, decision }] }
      )()
    }
    const strip = (): string[] => {
      const state = useAppStore.getState()
      return (state.groupsByWorktree[wt] ?? [])
        .flatMap((group) => group.tabOrder)
        .map(
          (id) =>
            state.unifiedTabsByWorktree[wt]
              ?.find((tab) => tab.id === id)
              ?.entityId.slice(wt.length + 1) ?? id
        )
    }
    revision.replaceRuntimeEnvironmentRevisions([{ id: env, createdAt: 0, pairingRevision: 3 }])
    try {
      expect(requested).not.toHaveBeenCalled()
      apply(1)
      const ticket = intent.beginWebSessionCloseIntent(
        { environmentId: env },
        wt,
        closedId,
        Date.now()
      )
      if (!ticket) {
        throw new Error('missing close ticket')
      }
      expect(ticket.placement).toBeDefined()
      expect(ticket.owner.pairingRevision).toBe(3)
      apply(2)
      expect(strip()).toEqual(['a', 'c'])
      const reread = vi.fn(async (_acceptCurrent: boolean) => {})
      const result = settleHostSessionTabClose({
        tickets: () => [ticket],
        close: Promise.reject(new Error('offline')),
        reread,
        readAfterClose: false
      })
      await vi.waitFor(() => expect(requested).toHaveBeenCalledOnce())
      expect(reread).toHaveBeenCalledWith(true)
      expect(project).not.toHaveBeenCalled()
      expect(strip()).toEqual(['a', 'c'])
      if (scenario === 'reclose') {
        const newer = intent.beginWebSessionCloseIntent(
          { environmentId: env },
          wt,
          closedId,
          Date.now()
        )
        expect(newer?.entry).not.toBe(ticket.entry)
      } else if (scenario === 'repair') {
        revision.replaceRuntimeEnvironmentRevisions([{ id: env, createdAt: 0, pairingRevision: 4 }])
        expect(revision.getRuntimeEnvironmentRevision(env)).toBe(4)
      } else if (scenario === 'healthy') {
        apply(3)
      }
      release()
      await expect(result).resolves.toBe('failed')
      if (scenario === 'healthy') {
        expect(strip()).toEqual(['a', 'b', 'c'])
        expect(
          useAppStore.getState().unifiedTabsByWorktree[wt].find((tab) => tab.entityId === `${wt}-b`)
            ?.label
        ).toBe('b-3')
        expect(project).toHaveBeenCalledWith(ticket)
      } else {
        expect(strip()).toEqual(['a', 'c'])
      }
      if (scenario === 'reclose') {
        expect(project).not.toHaveBeenCalled()
        expect(
          intent.isWebSessionCloseIntentPending({ environmentId: env }, wt, closedId, Date.now())
        ).toBe(true)
      }
      if (scenario === 'repair') {
        expect(revision.getRuntimeEnvironmentRevision(env)).toBe(4)
        expect(ticket.owner.pairingRevision).toBe(3)
      }
      if (scenario === 'throw') {
        expect(warn).toHaveBeenCalledWith(
          '[session-tabs] could not restore closed tab from its host source',
          expect.objectContaining({ message: 'restore bookkeeping failed' })
        )
        expect(
          intent.isWebSessionCloseIntentPending({ environmentId: env }, wt, closedId, Date.now())
        ).toBe(false)
      }
    } finally {
      release()
      intent.resetWebSessionCloseIntentForTests()
      resetWebSessionTabsSnapshotFreshnessForTests()
      revision.replaceRuntimeEnvironmentRevisions([])
      useAppStore.setState(initial, true)
      vi.doUnmock('./host-session-tab-source-projection')
      vi.restoreAllMocks()
    }
  }
)
