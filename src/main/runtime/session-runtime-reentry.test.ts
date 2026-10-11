import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from './orca-runtime'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

class SessionRuntime extends OrcaRuntimeService {
  readonly refreshArgumentCounts: number[] = []
  readonly reloadRequests: number[] = []
  restoreRequests = 0
  restoreResult = Promise.resolve()

  override async resolveWorktreeSelector(): Promise<ResolvedWorktree> {
    const git = {
      path: 'workspace',
      head: '',
      branch: 'selected',
      isBare: false,
      isMainWorktree: false
    }
    return {
      ...git,
      git,
      id: 'workspace',
      repoId: 'repo',
      displayName: '',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null
    }
  }

  protected override refreshMobileSessionPtyRecords(
    ...args: Parameters<OrcaRuntimeService['refreshMobileSessionPtyRecords']>
  ): Promise<Set<string> | null> {
    this.refreshArgumentCounts.push(args.length)
    return Promise.resolve(null)
  }

  protected override hydrateHeadlessMobileSessionTabsFromWorkspaceSession(): Set<string> {
    return new Set()
  }

  protected override restoreLivePairedRendererSessionOwnedMobileTerminals(): void {}

  protected override beginGraphReload(windowId: number): number {
    this.reloadRequests.push(windowId)
    return 77
  }

  protected override hasPersistedStructuredAgentSessionStore(): boolean {
    return true
  }

  override prepareStructuredAgentSessionStartupRestoration(): Promise<void> {
    return Promise.resolve()
  }

  protected override restoreStructuredAgentSessionTabsOnce(): Promise<void> {
    this.restoreRequests += 1
    return this.restoreResult
  }

  seedHeadlessSnapshot(snapshot: RuntimeMobileSessionTabsSnapshot): void {
    this.mobileSessionTabsByWorktree.set(snapshot.worktree, snapshot)
  }

  setHostTabResolver(
    resolver: (snapshot: RuntimeMobileSessionTabsSnapshot, tabId: string) => string | null
  ): void {
    this.resolveMobileSessionHostTabId = resolver
  }

  restoreTabs(): Promise<void> {
    return this.restoreStructuredAgentSessionTabs()
  }

  closeTab(tab: RuntimeMobileSessionAgentTab): Promise<void> {
    return this.closeStructuredAgentSessionTab(tab, 'user-close')
  }
}

afterEach(() => setStructuredAgentSessionHost(null))

describe('session runtime reentry', () => {
  it('keeps omitted refresh arguments omitted after asynchronous workspace resolution', async () => {
    const runtime = new SessionRuntime()

    await runtime.listMobileSessionTabs('selected')

    expect(runtime.refreshArgumentCounts).toEqual([0])
  })

  it('uses public methods replaced after construction', async () => {
    const runtime = new SessionRuntime()
    const list = vi.spyOn(runtime, 'listAllMobileSessionTabsWithChangeSequence').mockResolvedValue({
      snapshots: [],
      changeSequence: 73
    })
    const project = vi
      .spyOn(runtime, 'projectStructuredAgentSessionTab')
      .mockImplementation(() => {})
    const input = {
      workspaceId: 'workspace',
      sessionId: 'session',
      agent: 'claude',
      activate: false
    } satisfies Parameters<OrcaRuntimeService['publishStructuredAgentSessionTab']>[0]

    await expect(runtime.listAllMobileSessionTabs('client')).resolves.toEqual([])
    await runtime.publishStructuredAgentSessionTab(input)

    expect(list).toHaveBeenCalledExactlyOnceWith('client')
    expect(project).toHaveBeenCalledExactlyOnceWith(input)
  })

  it('re-enters the protected graph reload override', () => {
    const runtime = new SessionRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    expect(runtime.markRendererReloading(1)).toEqual({ revision: 77, recovery: 'renderer' })
    expect(runtime.reloadRequests).toEqual([1])
  })

  it('shares the protected asynchronous restoration operation', async () => {
    const runtime = new SessionRuntime()
    const gate = Promise.withResolvers<void>()
    runtime.restoreResult = gate.promise

    const first = runtime.restoreTabs()
    const second = runtime.restoreTabs()

    expect(first).toBe(second)
    expect(runtime.restoreRequests).toBe(1)
    gate.resolve()
    await first
  })

  it('looks up the headless callback callee after evaluating the move arguments', async () => {
    const runtime = new SessionRuntime()
    const snapshot: RuntimeMobileSessionTabsSnapshot = {
      worktree: 'workspace',
      publicationEpoch: 'epoch',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }
    runtime.seedHeadlessSnapshot(snapshot)
    const first = vi.fn(() => null)
    const replacement = vi.fn(function (
      this: OrcaRuntimeService,
      received: RuntimeMobileSessionTabsSnapshot,
      tabId: string
    ) {
      expect(this).toBe(runtime)
      expect(received).toBe(snapshot)
      expect(tabId).toBe('tab')
      return null
    })
    runtime.setHostTabResolver(first)

    await expect(
      runtime.moveMobileSessionTab('selected', {
        kind: 'reorder',
        get tabId() {
          runtime.setHostTabResolver(replacement)
          return 'tab'
        },
        targetGroupId: 'group',
        tabOrder: ['tab']
      })
    ).rejects.toThrow('tab_not_found')

    expect(first).not.toHaveBeenCalled()
    expect(replacement).toHaveBeenCalledExactlyOnceWith(snapshot, 'tab')
  })

  it('captures the runtime callee before a tab getter replaces it', async () => {
    const runtime = new SessionRuntime()
    const first = vi.fn(function (this: OrcaRuntimeService, sessionId: string) {
      expect(this).toBe(runtime)
      expect(sessionId).toBe('session')
      return false
    })
    const replacement = vi.fn(() => false)
    runtime.retireStructuredAgentSessionTabFromSnapshot = first
    const tab: RuntimeMobileSessionAgentTab = {
      type: 'agent-session',
      id: 'agent-session:session',
      title: '',
      agent: 'claude',
      isActive: false,
      get sessionId() {
        runtime.retireStructuredAgentSessionTabFromSnapshot = replacement
        return 'session'
      }
    }

    await runtime.closeTab(tab)

    expect(first).toHaveBeenCalledOnce()
    expect(replacement).not.toHaveBeenCalled()
    await runtime.closeTab(tab)
    expect(replacement).toHaveBeenCalledExactlyOnceWith('session')
  })
})
