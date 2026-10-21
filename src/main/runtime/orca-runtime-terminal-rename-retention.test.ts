import './orca-runtime-test-lifecycle.spec'
import type { RuntimeStore } from './runtime-store-contract'
import { describe, expect, it, vi } from 'vitest'
import { createMobileCreateTestNotifier } from './orca-runtime-test-scenario-builders.spec'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import type { RuntimeNotifier } from './runtime-notifier-contract'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { bindPaneFirst, committingSpawn } from './bind-first-pane.test-fixture'

describe('terminal rename before renderer graph hydration', () => {
  it.each(['Media Engine Orch', null])(
    'persists and forwards title %s across PTY replacement',
    async (title) => {
      const session = makeWorkspaceSessionWithHeadlessTerminal()
      session.tabsByWorktree[TEST_WORKTREE_ID][0].customTitle = 'Previous name'
      const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture supplies RuntimeStore methods; its legacy Mock return type loses callable signatures.
      const checkedStore = runtimeStore as RuntimeStore
      const runtime = new OrcaRuntimeService(checkedStore)
      const renameTerminal = vi.fn()
      runtime.setPtyController({
        spawn: vi.fn(committingSpawn(runtime, async () => ({ id: 'omp-initial-pty' }))),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.setNotifier({
        worktreesChanged: vi.fn(),
        reposChanged: vi.fn(),
        activateWorktree: vi.fn(),
        createTerminal: vi.fn(),
        splitTerminal: vi.fn(),
        renameTerminal,
        focusTerminal: vi.fn(),
        closeTerminal: vi.fn(),
        sleepWorktree: vi.fn(),
        terminalFitOverrideChanged: vi.fn(),
        terminalDriverChanged: vi.fn()
      })
      const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID
      })

      await runtime.renameTerminal(created.handle, title)

      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID][0].customTitle).toBe(title)
      expect(renameTerminal).toHaveBeenCalledWith('host-tab', title)
      // Switch-on, main closes a tab whose last terminal exits, so there the PTY is replaced by a
      // restart: a new runtime over the same saved session.
      if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
        runtime.onPtyExit('omp-initial-pty', 0)
      }
      const restored = new OrcaRuntimeService(checkedStore)
      restored.setPtyController({
        spawn: vi.fn(committingSpawn(restored, async () => ({ id: 'omp-replacement-pty' }))),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      await restored.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'host-tab',
        leafId: HEADLESS_LEAF_ID
      })
      expect(getSession().tabsByWorktree[TEST_WORKTREE_ID][0].customTitle).toBe(title)
    }
  )
  it('does not recreate a closed persisted tab from a surviving PTY record', async () => {
    const session = makeWorkspaceSessionWithHeadlessTerminal()
    const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(session)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Shared fixture implements RuntimeStore; its legacy Mock typing loses callable signatures.
    const runtime = new OrcaRuntimeService(runtimeStore as RuntimeStore)
    const notifier = createMobileCreateTestNotifier(vi.fn())
    runtime.setNotifier(notifier)
    runtime.setPtyController({
      spawn: vi.fn(committingSpawn(runtime, async () => ({ id: 'surviving-pty' }))),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID
    })
    setSession({ ...getSession(), tabsByWorktree: { [TEST_WORKTREE_ID]: [] } })
    runtimeStore.setWorkspaceSession.mockClear()

    await runtime.renameTerminal(created.handle, 'Late rename')

    expect(getSession().tabsByWorktree[TEST_WORKTREE_ID]).toEqual([])
    expect(runtimeStore.setWorkspaceSession).not.toHaveBeenCalled()
  })
})

describe('terminal view rename characterization', () => {
  function notifier(renameTerminal: RuntimeNotifier['renameTerminal']): RuntimeNotifier {
    return {
      worktreesChanged() {},
      reposChanged() {},
      activateWorktree() {},
      createTerminal() {},
      splitTerminal() {},
      renameTerminal,
      focusTerminal() {},
      closeTerminal() {},
      sleepWorktree() {},
      terminalFitOverrideChanged() {},
      terminalDriverChanged() {}
    }
  }
  it('keeps rename persistence before the current notifier with its own receiver', async () => {
    // Switch-on, main's layout says which tab holds the terminal; that layout lives in a store.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rename path reads only the session bindPaneFirst adds to this store.
    const runtime = new OrcaRuntimeService(ORCA_LAYOUT_OWNER_IS_MAIN ? ({} as never) : undefined)
    bindPaneFirst(runtime, {
      worktreeId: 'folder-workspace',
      tabId: 'host-tab',
      leafId: '00000000-0000-4000-8000-000000000002',
      ptyId: 'rename-pty'
    })
    const pty = runtime['recordPtyWorktree']('rename-pty', 'folder-workspace', {
      tabId: 'host-tab'
    })
    const handle = runtime['issuePtyHandle'](pty)
    const receivers: OrcaRuntimeService[] = []
    const events: string[] = []
    const replacement = notifier(function (this: RuntimeNotifier, tabId, title) {
      expect(this).toBe(replacement)
      expect([tabId, title]).toEqual(['host-tab', 'Pinned'])
      events.push('replacement')
    })
    runtime.setNotifier(notifier(() => events.push('original')))
    runtime['persistHeadlessTerminalTitle'] = function (this: OrcaRuntimeService, ...args) {
      receivers.push(this)
      expect(args).toEqual(['folder-workspace', 'host-tab', 'Pinned'])
      events.push('persist')
      runtime.setNotifier(replacement)
    }
    runtime['touchMobileSessionSnapshotsForPty'] = function (this: OrcaRuntimeService, ptyId) {
      receivers.push(this)
      expect(ptyId).toBe('rename-pty')
      expect(pty.title).toBe('Pinned')
      expect(pty.titleUpdatedAt).toBeGreaterThan(0)
      events.push('touch')
    }
    await expect(runtime.renameTerminal(handle, 'Pinned')).resolves.toEqual({
      handle,
      tabId: 'host-tab',
      title: 'Pinned'
    })
    expect(events).toEqual(['touch', 'persist', 'replacement'])
    expect(receivers).toEqual([runtime, runtime])
    runtime.onPtyExit('rename-pty', 0)
  })
})

describe('terminal query erased boundary regressions', () => {
  // paneOfPty reads the record's pane once, so a value that changes between reads cannot split one
  // summary (L80); a plain record never does that.
  it('summarizes from one read of the pane, though a later read would differ', () => {
    class SummaryRuntime extends OrcaRuntimeService {
      summarize() {
        const pty = this.recordPtyWorktree('changing-binding', 'missing', { connected: false })
        pty.tabId = 'tab'
        pty.surfaceRecordedAtGraphSequence = 1
        let reads = 0
        Object.defineProperty(pty, 'paneKey', {
          get: () => (++reads === 1 ? null : 'tab:00000000-0000-4000-8000-000000000001')
        })
        const issueHandle = vi.fn(() => 'handle')
        Object.defineProperty(this, 'issuePtyHandle', { value: issueHandle })
        expect(this.buildPtyTerminalSummary(pty, new Map())).toMatchObject({
          orphaned: true,
          tabId: 'pty:changing-binding'
        })
        expect(reads).toBe(ORCA_LAYOUT_OWNER_IS_MAIN ? 0 : 1)
        expect(issueHandle).toHaveBeenCalledExactlyOnceWith(pty)
      }
    }
    new SummaryRuntime(null).summarize()
  })

  it('dispatches destructive removal through the Root provider override', async () => {
    class TeardownRuntime extends OrcaRuntimeService {
      readonly providerReads = vi.fn()
      override getLocalProvider() {
        this.providerReads(this, arguments.length)
        return null
      }
      remove(connectionId?: string) {
        return this.stopPtysForDestructiveWorktreeRemoval('folder:notes', { connectionId })
      }
    }
    const runtime = new TeardownRuntime(null)
    await expect(runtime.remove()).rejects.toThrow('PTY provider unavailable')
    expect(runtime.providerReads).toHaveBeenCalledExactlyOnceWith(runtime, 0)
    runtime.providerReads.mockClear()
    await expect(runtime.remove('ssh-host')).rejects.toThrow('PTY provider unavailable')
    expect(runtime.providerReads).not.toHaveBeenCalled()
  })
})
