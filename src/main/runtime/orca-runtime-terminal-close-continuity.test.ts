import { describe, expect, it, vi } from 'vitest'
import {
  createHarness,
  createPtyBackedPublishedSurfaceHarness,
  createStaleTabCloseHarness,
  INCARNATION_ID,
  LEAF_ID,
  OTHER_WORKTREE_ID,
  PTY_ID,
  RUNTIME_OWNED_PTY_ID,
  SIBLING_INCARNATION_ID,
  SIBLING_LEAF_ID,
  SIBLING_PTY_ID,
  STALE_TAB_ID,
  TAB_ID,
  WORKTREE_ID
} from './__fixtures__/orca-runtime-terminal-close-continuity-fixtures'

describe('terminal close and handle incarnation continuity', () => {
  it('closes a stale spawn-time tab through its current PTY-backed surface', async () => {
    const harness = await createStaleTabCloseHarness()
    const { terminal } = harness

    await expect(harness.runtime.closeTerminalTab(terminal.handle)).resolves.toMatchObject({
      handle: terminal.handle,
      tabId: TAB_ID,
      closeMode: 'tab'
    })

    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
  })

  it('kills and removes a stale spawn-time tab through its current headless surface', async () => {
    const harness = await createStaleTabCloseHarness({ headless: true })
    const { terminal } = harness
    const published = vi.fn()
    const unsubscribe = harness.runtime.onMobileSessionTabsChanged(published)

    await expect(harness.runtime.closeTerminalTab(terminal.handle)).resolves.toMatchObject({
      handle: terminal.handle,
      tabId: TAB_ID,
      closeMode: 'tab'
    })

    expect(harness.kill).toHaveBeenCalledWith(RUNTIME_OWNED_PTY_ID)
    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(harness.flushOrThrow.mock.invocationCallOrder[0]).toBeLessThan(
      harness.kill.mock.invocationCallOrder[0]!
    )
    // Publishes reach subscribers through the coalescer.
    await vi.waitFor(() => expect(published).toHaveBeenCalled())
    expect(harness.flushOrThrow.mock.invocationCallOrder[0]).toBeLessThan(
      published.mock.invocationCallOrder[0]!
    )
    await expect(harness.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).resolves.toMatchObject(
      {
        retiredTerminalSurfaces: [
          {
            parentTabId: TAB_ID,
            leafId: LEAF_ID,
            ptyId: RUNTIME_OWNED_PTY_ID,
            terminal: terminal.handle
          }
        ],
        tabs: []
      }
    )
    unsubscribe()
  })

  it('still kills and keeps the removal when the durable headless close fails to flush', async () => {
    const harness = await createStaleTabCloseHarness({ headless: true })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    harness.rejectPersistenceFlush(new Error('disk-full'))

    await expect(harness.runtime.closeTerminalTab(harness.terminal.handle)).resolves.toMatchObject({
      tabId: TAB_ID,
      closeMode: 'tab'
    })

    // Why: a failed flush is bookkeeping; the user's close still stops its process and the
    // in-memory removal stays for the next flush to write.
    expect(harness.kill).toHaveBeenCalledWith(RUNTIME_OWNED_PTY_ID)
    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
    const snapshot = await harness.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    expect(snapshot.tabs).toEqual([])
    expect(errorSpy).toHaveBeenCalledWith(
      '[workspace-layout] could not save the layout:',
      expect.any(Error)
    )
    errorSpy.mockRestore()
  })

  it('publishes each split leaf retirement with its own terminal handle', async () => {
    const harness = createHarness({ publishMobileSurface: true, registerPtyBacked: true })
    harness.syncSplitFixtureGraph()
    const before = await harness.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    const terminalsByLeafId = new Map(
      before.tabs.flatMap((tab) =>
        tab.type === 'terminal' && tab.terminal ? [[tab.leafId, tab.terminal] as const] : []
      )
    )
    expect(terminalsByLeafId.size).toBe(2)
    harness.syncEmptyGraph()

    await expect(
      harness.runtime.closeMobileSessionTab(`id:${WORKTREE_ID}`, TAB_ID, { reason: 'user' })
    ).resolves.toMatchObject({ closed: true })

    const after = await harness.runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    expect(after.tabs).toEqual([])
    expect(after.retiredTerminalSurfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          leafId: LEAF_ID,
          ptyId: PTY_ID,
          terminal: terminalsByLeafId.get(LEAF_ID)
        }),
        expect.objectContaining({
          leafId: SIBLING_LEAF_ID,
          ptyId: SIBLING_PTY_ID,
          terminal: terminalsByLeafId.get(SIBLING_LEAF_ID)
        })
      ])
    )
  })

  it('does not let a colliding PTY id close a different persisted incarnation', async () => {
    const harness = await createStaleTabCloseHarness({ headless: true })
    harness.replacePersistedIncarnation(SIBLING_INCARNATION_ID)
    const { terminal } = harness

    await expect(harness.runtime.closeTerminalTab(terminal.handle)).rejects.toThrow(
      'terminal_handle_stale'
    )

    expect(harness.kill).not.toHaveBeenCalled()
    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
  })

  it('does not let a PTY handle cross its recorded worktree boundary', async () => {
    const harness = await createStaleTabCloseHarness({ headless: true })
    const { terminal } = harness
    harness.runtime.registerPty(RUNTIME_OWNED_PTY_ID, OTHER_WORKTREE_ID, null, {
      tabId: STALE_TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION_ID
    })

    await expect(harness.runtime.closeTerminalTab(terminal.handle)).rejects.toThrow(
      'terminal_handle_stale'
    )

    expect(harness.kill).not.toHaveBeenCalled()
    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
  })

  it('retires the tab before it stops the final PTY', async () => {
    const harness = createHarness()
    const [{ handle }] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    const tabsAtStop: unknown[] = []
    harness.setStopAndWaitAction(() => {
      tabsAtStop.push(harness.getSession().tabsByWorktree[WORKTREE_ID])
    })

    await expect(harness.runtime.closeTerminal(handle)).resolves.toMatchObject({
      handle,
      tabId: TAB_ID
    })

    expect(tabsAtStop).toEqual([[]])
    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toEqual([])
  })

  it('does not kill the final PTY of a pinned tab', async () => {
    const harness = createHarness()
    const [{ handle }] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    harness.editSession((session) => ({
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [WORKTREE_ID]: session.tabsByWorktree[WORKTREE_ID]!.map((tab) => ({
          ...tab,
          isPinned: true
        }))
      }
    }))

    await expect(harness.runtime.closeTerminal(handle)).rejects.toThrow('terminal_tab_pinned')

    expect(harness.kill).not.toHaveBeenCalled()
    expect(harness.getSession().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
  })

  it('requests a stop for every live tab PTY when the tab closes', async () => {
    const harness = createHarness()
    harness.syncSplitFixtureGraph()
    const terminal = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals.find(
      (candidate) => candidate.ptyId === PTY_ID
    )!

    await expect(harness.runtime.closeTerminalTab(terminal.handle)).resolves.toMatchObject({
      ptyKilled: false
    })
    expect(harness.kill).toHaveBeenCalledWith(PTY_ID)
    expect(harness.kill).toHaveBeenCalledWith(SIBLING_PTY_ID)
  })

  it('uses verified teardown after retirement before falling back to kill', async () => {
    const harness = createHarness()
    const [{ handle }] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    harness.setVerifiedStopResult(true)

    const closing = harness.runtime.closeTerminal(handle)
    await expect(closing).resolves.toMatchObject({ ptyKilled: true })
    expect(harness.stopAndWait).toHaveBeenCalledWith(PTY_ID, {
      deadlineMs: expect.any(Number)
    })
    expect(harness.kill).not.toHaveBeenCalled()
  })

  it('reports an unconfirmed stop on the close receipt rather than a bare uncertain false', async () => {
    const harness = createHarness()
    const [{ handle }] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    // Mirrors pty.ts when the SSH provider is gone: the lease is tombstoned, the
    // stop reports false, and the PTY is marked as contact we lost — not a kill.
    harness.kill.mockReturnValue(false)
    harness.setVerifiedStopResult(false)
    harness.runtime.markPtyLivenessUnverifiable(PTY_ID, 'its SSH provider is no longer registered')

    const closing = harness.runtime.closeTerminal(handle)

    await expect(closing).resolves.toMatchObject({
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable',
      ptyStopReason: 'its SSH provider is no longer registered'
    })
    expect(harness.kill).not.toHaveBeenCalled()
  })

  it('downgrades a live verdict after issuing an unverified follow-up stop', async () => {
    const harness = createHarness()
    const [{ handle }] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    harness.setVerifiedStopResult(false)
    harness.runtime.markPtyLivenessLive(PTY_ID)

    const closing = harness.runtime.closeTerminal(handle)

    await expect(closing).resolves.toMatchObject({
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable',
      ptyStopReason: 'a follow-up stop was issued but its outcome could not be verified'
    })
    expect(harness.kill).toHaveBeenCalledWith(PTY_ID)
  })

  it('leaves a confirmed kill receipt free of any stop verdict', async () => {
    const harness = createHarness()
    const [{ handle }] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    harness.setVerifiedStopResult(true)

    const closing = harness.runtime.closeTerminal(handle)

    const close = await closing
    expect(close.ptyKilled).toBe(true)
    expect(close.ptyStopVerdict).toBeUndefined()
    expect(close.ptyStopReason).toBeUndefined()
  })

  it('reports an unconfirmed stop when verified teardown rejects after retirement', async () => {
    const harness = createHarness()
    const [{ handle }] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    harness.setVerifiedStopResult(new Error('provider_unavailable'))

    const closing = harness.runtime.closeTerminal(handle)

    await expect(closing).resolves.toMatchObject({
      ptyKilled: false,
      ptyStopVerdict: 'unverifiable',
      ptyStopReason: 'provider_unavailable'
    })
    expect(harness.stopAndWait).toHaveBeenCalledWith(PTY_ID, {
      deadlineMs: expect.any(Number)
    })
    expect(harness.kill).toHaveBeenCalledWith(PTY_ID)
  })

  it('does not tear down a published PTY of a pinned tab', async () => {
    const harness = createPtyBackedPublishedSurfaceHarness()
    harness.editSession((session) => ({
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [WORKTREE_ID]: session.tabsByWorktree[WORKTREE_ID]!.map((tab) => ({
          ...tab,
          isPinned: true
        }))
      }
    }))
    const [terminal] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals

    await expect(harness.runtime.closeTerminal(terminal.handle)).rejects.toThrow(
      'terminal_tab_pinned'
    )
    expect(harness.stopAndWait).not.toHaveBeenCalled()
    expect(harness.kill).not.toHaveBeenCalled()
  })

  it('keeps a handle valid when renderer reload preserves the PTY incarnation', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals

    harness.runtime.markRendererReloading(1)
    harness.syncFixtureGraph()

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after).toMatchObject({ handle: before.handle, incarnationId: INCARNATION_ID })
    await expect(harness.runtime.readTerminal(before.handle)).resolves.toMatchObject({
      handle: before.handle,
      status: 'running'
    })
  })

  it('keeps a handle through an intermediate empty reload graph', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;\u280b Working on task\x07output\n', 100)
    const waiting = harness.runtime.waitForTerminal(before.handle, {
      condition: 'tui-idle',
      timeoutMs: 1_000
    })

    harness.runtime.markRendererReloading(1)
    harness.syncEmptyGraph()
    harness.syncFixtureGraph()
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;\u2733 Task complete\x07done\n', 200)

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).toBe(before.handle)
    await expect(waiting).resolves.toMatchObject({
      handle: before.handle,
      condition: 'tui-idle',
      satisfied: true
    })
    await expect(harness.runtime.readTerminal(before.handle)).resolves.toMatchObject({
      handle: before.handle,
      status: 'running'
    })
  })

  it('resolves a retained handle waiter when idle arrives during renderer reload', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;\u280b Working on task\x07output\n', 100)
    const waiting = harness.runtime.waitForTerminal(before.handle, {
      condition: 'tui-idle',
      timeoutMs: 1_000
    })

    harness.runtime.markRendererReloading(1)
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;\u2733 Task complete\x07done\n', 200)

    await expect(waiting).resolves.toMatchObject({
      handle: before.handle,
      condition: 'tui-idle',
      satisfied: true
    })
    harness.syncFixtureGraph()
    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).toBe(before.handle)
  })

  it('stales the old handle when the same PTY id names a new incarnation', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals

    harness.runtime.markRendererReloading(1)
    harness.replaceIncarnation('33333333-3333-4333-8333-333333333333')
    harness.syncFixtureGraph()

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).not.toBe(before.handle)
    expect(after.incarnationId).toBe('33333333-3333-4333-8333-333333333333')
    await expect(harness.runtime.readTerminal(before.handle)).rejects.toThrow(
      'terminal_handle_stale'
    )
  })

  it('stales a retained handle after the renderer graph becomes unavailable', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals

    harness.runtime.markGraphUnavailable(1)
    harness.runtime.attachWindow(1)
    harness.syncFixtureGraph()

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).not.toBe(before.handle)
    await expect(harness.runtime.readTerminal(before.handle)).rejects.toThrow(
      'terminal_handle_stale'
    )
  })

  it('stales a renderer handle superseded by a preallocated handle', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    const preallocated = 'term_preallocated-close-continuity'

    harness.runtime.registerPreAllocatedHandleForPty(PTY_ID, preallocated)
    await expect(harness.runtime.readTerminal(before.handle)).rejects.toThrow(
      'terminal_handle_stale'
    )
    await expect(harness.runtime.readTerminal(preallocated)).resolves.toMatchObject({
      handle: preallocated,
      status: 'running'
    })
    harness.syncFixtureGraph()

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).toBe(preallocated)
    await expect(harness.runtime.readTerminal(preallocated)).resolves.toMatchObject({
      handle: preallocated,
      status: 'running'
    })
  })

  it('keeps a renderer handle when the controller adopts that same handle', async () => {
    const harness = createHarness()
    const [before] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals

    harness.runtime.registerPreAllocatedHandleForPty(PTY_ID, before.handle)
    harness.syncFixtureGraph()

    const [after] = (await harness.runtime.listTerminals(`id:${WORKTREE_ID}`)).terminals
    expect(after.handle).toBe(before.handle)
    await expect(harness.runtime.readTerminal(before.handle)).resolves.toMatchObject({
      handle: before.handle,
      status: 'running'
    })
  })

  it('rejects a preallocated-handle waiter when its PTY is invalidated during reload', async () => {
    const harness = createHarness()
    const preallocated = 'term_preallocated-reload-invalidation'
    harness.runtime.registerPreAllocatedHandleForPty(PTY_ID, preallocated)
    harness.syncFixtureGraph()
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;\u280b Working on task\x07output\n', 100)
    const waiting = harness.runtime.waitForTerminal(preallocated, {
      condition: 'tui-idle',
      timeoutMs: 100
    })

    harness.runtime.markRendererReloading(1)
    harness.runtime['invalidateAllHandlesForPty'](PTY_ID)

    await expect(waiting).rejects.toThrow('terminal_handle_stale')
  })
})
