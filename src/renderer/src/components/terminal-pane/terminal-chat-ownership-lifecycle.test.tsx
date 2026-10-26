// @vitest-environment happy-dom
import {
  LEFT,
  RIGHT,
  ownershipFixture as mocks,
  makeFixture,
  useFixture,
  terminalChatProcessRows
} from './terminal-chat-ownership.test-fixture'
import { TerminalInterfaceAuthority } from '../../../../main/agent-hooks/server/terminal-interface-authority'
import { inspectPosixTerminalInterface } from '../../../../main/providers/terminal-interface-process-evidence'
import { resolveRemoteForegroundEvidence } from '../../../../main/providers/agent-foreground-process'
import {
  updateNativeChatComposerDraft,
  readNativeChatComposerDraft,
  clearNativeChatComposerDraftsForTests
} from '../native-chat/native-chat-composer-draft-store'
import type { TerminalProcessInspection } from '../../../../shared/terminal-process-inspection'
import type { TerminalInterfaceBinding } from '../../../../shared/terminal-interface-observation'
import { useNativeChatToggleShortcut } from '../native-chat/use-native-chat-toggle-shortcut'
import type { TerminalInterfaceObservation } from '../../../../shared/terminal-interface-observation'
import {
  applyTerminalInterfaceSnapshot,
  registerTerminalInterfacePresentation
} from '../native-chat/terminal-interface-presentation'
import { notifyPaneStartupStateChanged } from '@/lib/pane-spawn-deferral-registry'
import { selectTabBarAgentProjections } from '../tab-bar/tab-agent-types-by-tab-id'
import { act, renderHook } from '@testing-library/react'
import type { ConnectPanePtySession } from './pty-connection/connect-pane-pty-session'
import { installInterruptInputIntent } from './pty-connection/interrupt-input-intent'
import { createPane } from './pty-connection-test-pane-fixtures'
import { describe, expect, it, vi } from 'vitest'
import { createPaneForegroundAgentTracker } from './pane-foreground-agent-tracker'
import { detachTerminalLayoutLeaf } from './terminal-layout-leaf-detach'
import { parseWorkspaceSession } from '../../../../shared/workspace-session-schema'
import { useAppStore } from '../../store'
import { makePaneKey } from '../../../../shared/stable-pane-id'

describe('terminal chat ownership lifecycle', () => {
  it('releases suspended chat, rejects a shell sibling, and restores eligibility after fg', () => {
    const fixture = makeFixture()
    const hook = renderHook(() => useFixture(fixture, RIGHT))
    act(() => {
      useAppStore.setState({
        paneForegroundAgentByPaneKey: {
          [makePaneKey('tab', LEFT)]: { agent: null, shellForeground: true },
          [makePaneKey('tab', RIGHT)]: { agent: null, shellForeground: true }
        }
      })
      fixture.onAgentExitedRef.current(RIGHT)
    })
    expect(hook.result.current.chatLeafId).toBeNull()
    expect(mocks.state.unifiedTabsByWorktree.wt[0].viewMode).toBe('terminal')
    expect(hook.result.current.canToggleChatForLeaf(RIGHT)).toBe(false)
    expect(hook.result.current.canToggleChatForLeaf(LEFT)).toBe(false)
    act(() =>
      useAppStore.setState({
        paneForegroundAgentByPaneKey: {
          [makePaneKey('tab', RIGHT)]: { agent: 'codex', shellForeground: false }
        }
      })
    )
    expect(hook.result.current.canToggleChatForLeaf(RIGHT)).toBe(true)
    expect(hook.result.current.chatLeafId).toBeNull()
    expect(mocks.state.unifiedTabsByWorktree.wt[0].viewMode).toBe('terminal')
  })

  it('batches a pane toggle into chat and back without selecting the active sibling', () => {
    mocks.state.setTabViewMode('tab', 'terminal')
    const fixture = makeFixture()
    const hook = renderHook(() => useFixture(fixture, null))
    act(() => hook.result.current.toggleNativeChatForLeaf(RIGHT))
    expect(hook.result.current.chatLeafId).toBe(RIGHT)
    expect(mocks.state.unifiedTabsByWorktree.wt[0].viewMode).toBe('chat')
    expect(mocks.state.terminalLayoutsByTabId.tab.chatLeafId).toBe(RIGHT)
    act(() => hook.result.current.toggleNativeChatForLeaf(RIGHT))
    expect(hook.result.current.chatLeafId).toBeNull()
    expect(mocks.state.unifiedTabsByWorktree.wt[0].viewMode).toBe('terminal')
    expect(mocks.state.terminalLayoutsByTabId.tab.chatLeafId).toBeUndefined()
  })

  it('keeps a saved legacy chat and its explicit toggle available with Chat UI off', () => {
    const push = vi.fn()
    const fixture = makeFixture(undefined, { push })
    mocks.state.runtimePaneTitlesByTabId.tab = { 1: 'bash', 2: 'codex' }
    mocks.state.terminalLayoutsByTabId.tab.ptyIdsByLeafId = {
      [LEFT]: 'remote:host:terminal',
      [RIGHT]: 'remote:host:chat'
    }
    const hook = renderHook(() => useFixture(fixture, RIGHT))
    mocks.state.settings.experimentalNativeChat = false
    hook.rerender()
    hook.result.current.persistLayoutSnapshot()
    expect(hook.result.current.effectiveChatViewMode).toBe(true)
    expect(mocks.state.unifiedTabsByWorktree.wt[0].viewMode).toBe('chat')
    expect(mocks.state.terminalLayoutsByTabId.tab.chatLeafId).toBe(RIGHT)
    expect(hook.result.current.canToggleChatForLeaf(RIGHT)).toBe(true)
    expect(hook.result.current.canToggleChatForLeaf(LEFT)).toBe(false)
    expect(push).toHaveBeenLastCalledWith(
      expect.objectContaining({
        layout: expect.objectContaining({ chatLeafId: RIGHT })
      })
    )
    act(() => hook.result.current.toggleNativeChatForLeaf(RIGHT))
    expect(mocks.state.unifiedTabsByWorktree.wt[0].viewMode).toBe('terminal')
    expect(hook.result.current.canToggleChatForLeaf(RIGHT)).toBe(true)
    act(() => hook.result.current.toggleNativeChatForLeaf(RIGHT))
    expect(mocks.state.unifiedTabsByWorktree.wt[0].viewMode).toBe('chat')
  })

  it('clears ownership when the tab-bar turns chat off, then targets the active sibling', () => {
    const fixture = makeFixture()
    const hook = renderHook(() => useFixture(fixture, RIGHT))
    act(() => mocks.state.setTabViewMode('tab', 'terminal'))
    hook.rerender()
    expect(hook.result.current.chatLeafId).toBeNull()
    expect(mocks.state.terminalLayoutsByTabId.tab.chatLeafId).toBeUndefined()
    act(() => mocks.state.setTabViewMode('tab', 'chat'))
    hook.rerender()
    expect(hook.result.current.chatLeafId).toBe(LEFT)
  })

  it('keeps the current owner when a mount-time callback captures a pane for detaching', () => {
    const fixture = makeFixture()
    const hook = renderHook(() => useFixture(fixture, RIGHT))
    const mountedPersist = hook.result.current.persistLayoutSnapshot
    act(() => hook.result.current.toggleNativeChatForLeaf(LEFT))
    expect(hook.result.current.chatLeafId).toBe(LEFT)
    mountedPersist()
    const detached = detachTerminalLayoutLeaf(mocks.state.terminalLayoutsByTabId.tab, LEFT)
    expect(detached?.detachedLayout.chatLeafId).toBe(LEFT)
    expect(detached?.sourceLayout.chatLeafId).toBeUndefined()
  })

  it('does not resurrect an owner after chat is turned off and the split is resized', () => {
    const fixture = makeFixture()
    const hook = renderHook(() => useFixture(fixture, RIGHT))
    const mountedPersist = hook.result.current.persistLayoutSnapshot
    act(() => hook.result.current.switchNativeChatToTerminal())
    mountedPersist()
    expect(mocks.state.terminalLayoutsByTabId.tab.chatLeafId).toBeUndefined()
  })

  it('closing the chat leaf leaves an eligible terminal sibling in terminal mode', () => {
    const fixture = makeFixture()
    const hook = renderHook(() => useFixture(fixture, RIGHT))
    fixture.managerRef.current.getPanes().pop()?.container.remove()
    hook.rerender()
    expect(hook.result.current.chatLeafId).toBeNull()
    expect(mocks.state.unifiedTabsByWorktree.wt[0].viewMode).toBe('terminal')
  })

  it('restores chat on the right with the left active and different numeric pane IDs', () => {
    const initialFixture = makeFixture()
    const original = renderHook(() => useFixture(initialFixture, RIGHT))
    original.result.current.persistLayoutSnapshot()
    const session = parseWorkspaceSession(
      JSON.parse(
        JSON.stringify({
          activeRepoId: null,
          activeWorktreeId: 'wt',
          activeTabId: 'tab',
          tabsByWorktree: {},
          terminalLayoutsByTabId: mocks.state.terminalLayoutsByTabId
        })
      )
    )
    expect(session.ok).toBe(true)
    if (!session.ok) {
      throw new Error('session did not parse')
    }
    original.unmount()
    const saved = session.value.terminalLayoutsByTabId.tab!
    mocks.state.setTabLayout('tab', saved)
    expect(saved.activeLeafId).toBe(LEFT)
    expect(saved.root).toMatchObject({ first: { leafId: LEFT }, second: { leafId: RIGHT } })
    const restored = makeFixture([20, 10])
    const hook = renderHook(() => useFixture(restored, saved.chatLeafId ?? null))
    const chatPane = restored.managerRef.current
      .getPanes()
      .find((pane) => pane.leafId === hook.result.current.chatLeafId)
    expect(chatPane?.id).toBe(10)
    // Closing the restored chat leaf must leave the left terminal untouched.
    restored.managerRef.current.getPanes().pop()?.container.remove()
    hook.rerender()
    expect(restored.managerRef.current.getPanes().map((pane) => pane.leafId)).toEqual([LEFT])
    expect(hook.result.current.chatLeafId).toBeNull()
    expect(mocks.state.unifiedTabsByWorktree.wt[0].viewMode).toBe('terminal')
  })
})

it('converges a split Chat from rowless snapshots after slow launch settlement, then remounts with the same tab and pane eligibility', async () => {
  const fixture = makeFixture()
  mocks.state.setTabLayout('tab', {
    ...mocks.state.terminalLayoutsByTabId.tab,
    ptyIdsByLeafId: { [LEFT]: 'shell-left', [RIGHT]: 'pty' }
  })
  let pending = true
  const release = registerTerminalInterfacePresentation(`tab:${RIGHT}`, {
    ptyId: () => 'pty',
    incarnation: () => 'birth',
    pending: () => pending,
    cold: () => true
  })
  const observation: TerminalInterfaceObservation = {
    ptyId: 'pty',
    incarnationId: 'birth',
    terminalHandle: 'handle',
    paneKey: `tab:${RIGHT}`,
    worktreeId: 'wt',
    epoch: 'desktop-flow',
    revision: 1,
    inputRevision: 0,
    owner: 'original-hook',
    executionLaunchToken: 'launch-A',
    state: 'shell',
    basis: 'hook'
  }
  const publish = (right: TerminalInterfaceObservation): void =>
    applyTerminalInterfaceSnapshot(
      {
        type: 'terminalInterfaces',
        epoch: right.epoch,
        revision: right.revision,
        observations: [{ ...right, ptyId: 'shell-left', paneKey: `tab:${LEFT}` }, right]
      },
      null
    )
  useAppStore.setState({
    agentLaunchConfigByPaneKey: {
      [`tab:${RIGHT}`]: {
        launchConfig: { agentArgs: '', agentEnv: {} },
        registeredAt: 0,
        identity: { launchToken: 'launch-B' }
      }
    }
  })
  const hook = renderHook(() => useFixture(fixture, RIGHT))
  act(() => publish(observation))
  expect(hook.result.current.chatLeafId).toBe(RIGHT)
  await act(async () => {
    pending = false
    notifyPaneStartupStateChanged()
    await Promise.resolve()
  })
  // A delayed old snapshot has no authority over launch B, even if received after it.
  act(() => publish({ ...observation, revision: 2 }))
  expect(hook.result.current.chatLeafId).toBe(RIGHT)
  act(() => publish({ ...observation, revision: 3, executionLaunchToken: 'launch-B' }))
  expect(hook.result.current.chatLeafId).toBeNull()
  expect(hook.result.current.canToggleChatForLeaf(RIGHT)).toBe(false)
  expect(fixture.managerRef.current.getActivePane()?.leafId).toBe(LEFT)
  mocks.state.setTabLayout('tab', {
    ...mocks.state.terminalLayoutsByTabId.tab,
    activeLeafId: RIGHT
  })
  expect(
    selectTabBarAgentProjections(useAppStore.getState()).nativeChatShellForegroundTabsById.tab
  ).toBe(true)
  useAppStore.setState({
    activeWorktreeId: 'wt',
    activeGroupIdByWorktree: { wt: 'group' },
    groupsByWorktree: {
      wt: [{ id: 'group', worktreeId: 'wt', activeTabId: 'tab', tabOrder: ['tab'] }]
    }
  })
  const shortcut = renderHook(() => useNativeChatToggleShortcut('wt', true))
  const toggle = vi.spyOn(useAppStore.getState(), 'toggleTabViewMode')
  const isMac = navigator.userAgent.includes('Mac')
  act(() =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'j',
        shiftKey: true,
        metaKey: isMac,
        ctrlKey: !isMac,
        bubbles: true
      })
    )
  )
  expect(toggle).not.toHaveBeenCalled()
  toggle.mockRestore()
  shortcut.unmount()
  hook.unmount()
  const remount = renderHook(() => useFixture(makeFixture([20, 10]), RIGHT))
  act(() => publish({ ...observation, revision: 3, executionLaunchToken: 'launch-B' }))
  expect(remount.result.current.chatLeafId).toBeNull()
  expect(remount.result.current.canToggleChatForLeaf(RIGHT)).toBe(false)
  release()
})

it('keeps unchanged pane outputs quiet through real discovery, settlement and recognized-monitor notifications', async () => {
  vi.useFakeTimers()
  mocks.state.setTabViewMode('tab', 'terminal')
  const fixture = makeFixture()
  const publishUnrelated = (revision: number) =>
    applyTerminalInterfaceSnapshot(
      {
        type: 'terminalInterfaces',
        epoch: 'unrelated',
        revision,
        observations: [
          {
            ptyId: 'other-pty',
            incarnationId: 'birth',
            terminalHandle: 'other',
            paneKey: `other:${LEFT}`,
            worktreeId: 'wt',
            epoch: 'unrelated',
            revision,
            inputRevision: 0,
            owner: null,
            executionLaunchToken: null,
            state: 'agent',
            basis: 'process'
          }
        ]
      },
      null
    )
  publishUnrelated(1)
  let renders = 0
  const hook = renderHook(() => {
    renders += 1
    return useFixture(fixture, null)
  })
  const originalRenders = renders
  const callback = hook.result.current.isChatEligibleForLeaf
  const facts = useAppStore.getState().terminalInterfaceByPtyId
  const generic = vi.fn()
  const off = useAppStore.subscribe(generic)
  const tracker = createPaneForegroundAgentTracker({
    getPtyId: () => 'pty',
    isTrackablePtyId: () => true,
    readForegroundProcess: async () => 'codex',
    publish: vi.fn()
  })
  try {
    await act(async () => {
      tracker.onVisiblePtyBound()
      await vi.advanceTimersByTimeAsync(350)
      tracker.onForegroundAgentObserved({ agent: 'codex', processName: 'codex' })
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(useAppStore.getState().terminalInterfaceByPtyId).toBe(facts)
    expect(generic).not.toHaveBeenCalled()
    expect(renders).toBe(originalRenders)
    act(() => publishUnrelated(2))
    expect(renders).toBe(originalRenders)
    hook.rerender()
    expect(hook.result.current.isChatEligibleForLeaf).toBe(callback)
  } finally {
    off()
    tracker.dispose()
  }
})

it('releases a custom-title mounted Chat when only confirmed host release changes', () => {
  const fixture = makeFixture()
  mocks.state.runtimePaneTitlesByTabId.tab = { 1: 'My workspace', 2: 'My workspace' }
  mocks.state.setTabLayout('tab', {
    ...mocks.state.terminalLayoutsByTabId.tab,
    ptyIdsByLeafId: { [RIGHT]: 'pty' }
  })
  useAppStore.setState({
    paneForegroundAgentByPaneKey: {
      [`tab:${RIGHT}`]: { agent: null, shellForeground: true }
    }
  })
  const hook = renderHook(() => useFixture(fixture, RIGHT))
  expect(hook.result.current.chatLeafId).toBe(RIGHT)
  const callback = hook.result.current.isChatEligibleForLeaf
  hook.rerender()
  expect(hook.result.current.isChatEligibleForLeaf).toBe(callback)
  act(() =>
    applyTerminalInterfaceSnapshot(
      {
        type: 'terminalInterfaces',
        epoch: 'custom-title',
        revision: 1,
        observations: [
          {
            ptyId: 'pty',
            incarnationId: 'birth',
            terminalHandle: 'handle',
            paneKey: `tab:${RIGHT}`,
            worktreeId: 'wt',
            epoch: 'custom-title',
            revision: 1,
            inputRevision: 0,
            owner: null,
            executionLaunchToken: null,
            state: 'shell',
            basis: 'hook'
          }
        ]
      },
      null
    )
  )
  expect(hook.result.current.isChatEligibleForLeaf).not.toBe(callback)
  expect(hook.result.current.chatLeafId).toBeNull()
  expect(mocks.state.runtimePaneTitlesByTabId.tab[2]).toBe('My workspace')
})

it.each([false, true])(
  'composes actual D installer, real Done/launch teardown and mounted pending/cold Chat, then legacy episodes (foreground first=%s)',
  async (foregroundFirst) => {
    vi.useFakeTimers()
    const epoch = `installer-${foregroundFirst}`
    const previousApi = window.api
    const confirm = vi.fn(async () => 'zsh')
    let resolveFirstRead!: (value: string) => void
    confirm.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveFirstRead = resolve
      })
    )
    const drop = vi.fn()
    const reconcile = vi.fn()
    Object.assign(window, {
      api: {
        pty: { getForegroundProcess: confirm, confirmForegroundProcess: confirm },
        agentStatus: { drop, reconcileEndedProcess: reconcile }
      }
    })
    const fixture = makeFixture()
    const pane = createPane(2)
    const exited = vi.fn((leafId: string) => fixture.onAgentExitedRef.current(leafId))
    const paneKey = makePaneKey('tab', RIGHT)
    const ground = vi.fn()
    const title = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies all fields read by the complete interrupt/identity installers; transport and terminal effects remain external spies.
    const session = {
      cacheKey: paneKey,
      pendingSpawnKey: paneKey,
      pane,
      transport: { getPtyId: () => 'pty' },
      remotePtyIncarnationId: 'birth',
      spawnedFreshPtyId: 'pty',
      disposed: false,
      pendingStartupCommand: 'codex',
      startupInjectTimer: null,
      transportConnectInFlightSince: null,
      getSleepingRecordForPane: () => null,
      clearCommandInferredPaneAgentAfterPtySideEffects: vi.fn(),
      neutralTerminalTitle: () => 'Terminal',
      writeInputModeGround: ground,
      manager: fixture.managerRef.current,
      deps: {
        tabId: 'tab',
        worktreeId: 'wt',
        cwd: '/workspace',
        isPtyShutdownPending: () => false,
        setRuntimePaneTitle: title,
        updateTabTitle: vi.fn(),
        onAgentExitedRef: { current: exited }
      }
    } as unknown as ConnectPanePtySession
    installInterruptInputIntent(session)
    const hook = renderHook(() => useFixture(fixture, RIGHT))
    const finish = async () => {
      session.commandLifecycle.handlePtyData('\x1b]133;D;0\x07')
      await vi.advanceTimersByTimeAsync(350)
    }
    const row = () => useAppStore.getState().agentStatusByPaneKey[paneKey]
    const accept = () => {
      useAppStore
        .getState()
        .setAgentStatus(paneKey, { agentType: 'codex', state: 'done', prompt: 'task' })
      useAppStore
        .getState()
        .registerAgentLaunchConfig(
          paneKey,
          { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
          { agentType: 'codex', launchToken: 'future' }
        )
    }
    try {
      await act(async () => {
        accept()
        applyTerminalInterfaceSnapshot(
          {
            type: 'terminalInterfaces',
            epoch,
            revision: 1,
            observations: [
              {
                paneKey,
                ptyId: 'pty',
                incarnationId: 'birth',
                terminalHandle: 'handle',
                worktreeId: 'wt',
                epoch,
                revision: 1,
                inputRevision: 0,
                executionLaunchToken: null,
                owner: null,
                state: 'shell',
                basis: 'cold'
              }
            ]
          },
          null
        )
        if (foregroundFirst) {
          session.acceptAgentDeparture('foreground-release')
        }
        session.commandLifecycle.handlePtyData('\x1b]133;D;0\x07')
        session.acceptAgentDeparture('foreground-release')
        expect(session.paneForegroundAgentTracker.hasReadInFlight()).toBe(true)
        await vi.advanceTimersByTimeAsync(350)
        expect(confirm).toHaveBeenCalledOnce()
        session.acceptAgentDeparture('foreground-release')
        expect(session.paneForegroundAgentTracker.hasReadInFlight()).toBe(true)
        expect(row()).toBeDefined()
        expect(drop).not.toHaveBeenCalled()
        resolveFirstRead('zsh')
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(confirm).toHaveBeenCalledOnce() // No C or foreground recognition preceded D.
      expect(row()).toBeUndefined()
      expect(useAppStore.getState().agentLaunchConfigByPaneKey[paneKey]).toBeUndefined()
      expect(drop).toHaveBeenCalledWith(paneKey)
      expect(drop.mock.invocationCallOrder[0]).toBeLessThan(reconcile.mock.invocationCallOrder[0])
      session.acceptAgentDeparture('foreground-release')
      expect(session.paneForegroundAgentTracker.hasReadInFlight()).toBe(false)
      expect(hook.result.current.chatLeafId).toBe(RIGHT)
      expect(mocks.state.unifiedTabsByWorktree.wt[0].viewMode).toBe('chat')
      expect(ground).not.toHaveBeenCalled()
      expect(exited).not.toHaveBeenCalled()
      await act(async () => {
        session.pendingStartupCommand = null
        notifyPaneStartupStateChanged()
        await Promise.resolve()
      })
      expect(hook.result.current.chatLeafId).toBe(RIGHT) // Removed row cannot qualify cold release.
      expect(ground).not.toHaveBeenCalled()
      await act(async () => {
        useAppStore
          .getState()
          .setPaneForegroundAgent(makePaneKey('tab', LEFT), { agent: null, shellForeground: true })
        applyTerminalInterfaceSnapshot(
          { type: 'terminalInterfaces', epoch, revision: 2, observations: [] },
          null
        )
        accept()
        await finish()
      })
      expect(row()).toBeUndefined()
      expect(hook.result.current.chatLeafId).toBe(RIGHT)
      expect(mocks.state.unifiedTabsByWorktree.wt[0].viewMode).toBe('chat')
      expect(exited).not.toHaveBeenCalled()
      expect(ground).not.toHaveBeenCalled()
      await act(async () => {
        confirm.mockResolvedValueOnce('codex')
        session.commandLifecycle.handlePtyData('\x1b]133;C\x07')
        await vi.advanceTimersByTimeAsync(350)
        expect(useAppStore.getState().paneForegroundAgentByPaneKey[paneKey]).toMatchObject({
          agent: 'codex',
          agentEvidence: 'process-read'
        })
        accept()
        await finish()
      })
      expect(hook.result.current.chatLeafId).toBeNull()
      expect(ground).toHaveBeenCalledTimes(1)
      const reads = confirm.mock.calls.length
      await act(finish)
      expect(confirm).toHaveBeenCalledTimes(reads) // Accepted D ended tracker presentation history.
      expect(ground).toHaveBeenCalledTimes(1)
      await act(async () => {
        // A new armed D row still settles before the same-shell tail is suppressed.
        accept()
        await finish()
      })
      expect(row()).toBeUndefined()
      expect(ground).toHaveBeenCalledTimes(1)
      await act(async () => {
        accept()
        confirm.mockResolvedValueOnce('codex')
        session.commandLifecycle.handlePtyData('\x1b]133;C\x07')
        await vi.advanceTimersByTimeAsync(350)
        await finish()
      })
      expect(row()).toBeUndefined()
      expect(ground).toHaveBeenCalledTimes(2) // Actual execution after C owns a distinct departure episode.
      expect(title).toHaveBeenCalledTimes(2)
    } finally {
      session.paneForegroundAgentTracker.dispose()
      session.commandLifecycle.dispose()
      session.unregisterTerminalInterfacePresentation?.()
      Object.assign(window, { api: previousApi })
    }
  }
)

it('joins qualified producer recovery through queued successors to manual Chat and keeps stale or unknown proof refused', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
  const fixture = makeFixture()
  const paneKey = makePaneKey('tab', RIGHT)
  mocks.state.setTabLayout('tab', {
    ...mocks.state.terminalLayoutsByTabId.tab,
    ptyIdsByLeafId: { [RIGHT]: 'pty' }
  })
  const settings = useAppStore.getState().settings
  useAppStore.setState({
    paneForegroundAgentByPaneKey: Object.fromEntries(
      [LEFT, RIGHT].map((leaf) => [
        makePaneKey('tab', leaf),
        { agent: null, shellForeground: true }
      ])
    )
  })
  const draftScope = `pane:${paneKey}`
  updateNativeChatComposerDraft(draftScope, { text: 'Keep this unsent' }, 'deferred')
  const draft = readNativeChatComposerDraft(draftScope)
  let generation = 1
  let handle = 'handle'
  let foreground: 'agent' | 'shell' | 'unknown' = 'unknown'
  let capturedAgeMs = 0
  let tailMs = 0
  let pending: Promise<TerminalProcessInspection | null> | null = null
  let pendingStarted = false
  const binding = () => ({
    ptyId: 'pty',
    incarnationId: 'birth',
    terminalHandle: handle,
    paneKey,
    worktreeId: 'wt'
  })
  const authority = new TerminalInterfaceAuthority()
  let observationEpoch = 0
  const produced = vi.fn<(result: TerminalProcessInspection) => void>()
  const inspect = vi.fn(async (_binding: TerminalInterfaceBinding) => {
    if (pending) {
      pendingStarted = true
      return await pending
    }
    const rows = terminalChatProcessRows(foreground)
    const evidence = resolveRemoteForegroundEvidence(
      { rootPid: 100, fallbackProcess: null },
      {
        ptyId: 'pty',
        ptyIncarnationId: 'birth',
        authorityGeneration: 'producer',
        observationEpoch: ++observationEpoch,
        capturedAgeMs,
        platform: 'darwin'
      },
      rows
    )
    const terminalInterface = await inspectPosixTerminalInterface(100, '/bin/zsh', false, {
      rows,
      capturedAgeMs
    })
    if (tailMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, tailMs))
    }
    const result = {
      foregroundProcess: evidence.verdict === 'live' ? evidence.processName : null,
      hasChildProcesses: terminalInterface.children !== 'no-children',
      foregroundProcessEvidence: evidence,
      terminalInterface
    }
    produced(result)
    return result
  })
  const events: ReturnType<typeof authority.snapshotEvent>[] = []
  const publish = () => {
    const event = authority.snapshotEvent()
    events.push(event)
    applyTerminalInterfaceSnapshot(event, null)
  }
  const release = registerTerminalInterfacePresentation(paneKey, {
    ptyId: () => 'pty',
    incarnation: () => 'birth',
    pending: () => false,
    cold: () => false
  })
  mocks.state.setTabViewMode('tab', 'terminal')
  const hook = renderHook(() => useFixture(fixture, null))
  const advance = async (ms: number) => {
    await act(async () => vi.advanceTimersByTimeAsync(ms))
  }
  try {
    authority.install({
      inventory: () => [
        { binding: binding(), generation, launchToken: null, blocked: false, local: true }
      ],
      inspect,
      changed: publish
    })
    await advance(250)
    expect(authority.snapshot()).toEqual([])
    expect(hook.result.current.canToggleChatForLeaf(RIGHT)).toBe(false)
    expect(hook.result.current.chatLeafId).toBeNull()
    foreground = 'agent'
    authority.input('pty', 'driving')
    await advance(250)
    expect(hook.result.current.canToggleChatForLeaf(RIGHT)).toBe(true)
    act(() => hook.result.current.toggleNativeChatForLeaf(RIGHT))
    expect(authority.read('pty', 'birth')).toMatchObject({ state: 'agent', basis: 'process' })
    expect(hook.result.current.chatLeafId).toBe(RIGHT)
    foreground = 'shell' // The stopped child stays alive; the producer qualifies shell foreground.
    authority.input('pty', 'driving')
    await advance(2250)
    const suspended = events.at(-1)!
    expect(authority.read('pty', 'birth')?.state).toBe('shell')
    expect(hook.result.current.chatLeafId).toBeNull()
    expect(hook.result.current.canToggleChatForLeaf(RIGHT)).toBe(false)
    act(() => hook.result.current.toggleNativeChatForLeaf(RIGHT))
    expect(mocks.state.unifiedTabsByWorktree.wt[0].viewMode).toBe('terminal')

    foreground = 'unknown'
    authority.input('pty', 'driving')
    await advance(3250)
    expect(events.at(-1)).toEqual(suspended)
    expect(produced.mock.lastCall?.[0].terminalInterface?.children).toBe('unverifiable')
    expect(hook.result.current.canToggleChatForLeaf(RIGHT)).toBe(false)

    foreground = 'agent'
    capturedAgeMs = 600
    authority.input('pty', 'driving')
    await advance(250) // Age is below the limit, but this cached capture precedes the input.
    expect(produced.mock.lastCall?.[0].terminalInterface?.capturedAgeMs).toBe(600)
    expect(authority.read('pty', 'birth')?.state).toBe('shell')
    capturedAgeMs = 800
    tailMs = 610 // Source age plus post-stamp delay is stale, even though max(800,610) is not.
    authority.input('pty', 'driving')
    await advance(1000)
    expect(produced.mock.lastCall?.[0].terminalInterface?.capturedAgeMs).toBe(800)
    expect(authority.read('pty', 'birth')?.state).toBe('shell')
    expect(hook.result.current.canToggleChatForLeaf(RIGHT)).toBe(false)
    capturedAgeMs = 0
    tailMs = 500
    authority.input('pty', 'driving')
    await advance(250)
    authority.input('pty', 'driving') // Original request currentness survives the new envelope.
    await advance(500)
    expect(authority.read('pty', 'birth')?.state).toBe('shell')

    const orphan = Promise.withResolvers<TerminalProcessInspection | null>()
    pending = orphan.promise
    tailMs = 0
    authority.input('pty', 'driving')
    await advance(2000) // Let the prior input-fenced read finish and the owned slow run time out.
    expect(pendingStarted).toBe(true)
    const before = inspect.mock.calls.length
    await advance(250) // A timed-out waiter does not end its actual provider work.
    expect(inspect).toHaveBeenCalledTimes(before)
    generation += 1
    handle = 'superseded-successor'
    act(() => {
      authority.snapshotEvent()
    })
    await advance(250)
    generation += 1
    handle = 'current-successor'
    const latestRequestedAt = performance.now()
    act(() => {
      authority.snapshotEvent()
    })
    await advance(250)
    await advance(1000)
    expect(inspect).toHaveBeenCalledTimes(before)
    pending = null
    capturedAgeMs = 100 // Cached sample; dispatch-age must not discard its pre-request age.
    await act(async () => {
      orphan.resolve(null)
      await Promise.resolve()
    })
    expect(inspect).toHaveBeenCalledTimes(before + 1)
    expect(performance.now() - (latestRequestedAt + 250) + 100).toBeGreaterThan(1000)
    expect(inspect.mock.calls.at(-1)?.[0].terminalHandle).toBe('current-successor')
    expect(authority.read('pty', 'birth')).toMatchObject({
      state: 'agent',
      terminalHandle: 'current-successor'
    })
    expect(hook.result.current.canToggleChatForLeaf(RIGHT)).toBe(true)
    expect(hook.result.current.chatLeafId).toBeNull() // No automatic reselect after fg.
    act(() => hook.result.current.toggleNativeChatForLeaf(RIGHT))
    expect(hook.result.current.chatLeafId).toBe(RIGHT)
    expect(mocks.state.unifiedTabsByWorktree.wt[0].viewMode).toBe('chat')
    act(() => applyTerminalInterfaceSnapshot(suspended, null))
    await advance(250)
    expect(hook.result.current.chatLeafId).toBe(RIGHT)
    expect(mocks.state.unifiedTabsByWorktree.wt[0].viewMode).toBe('chat')
    expect(useAppStore.getState().settings).toBe(settings)
    expect(readNativeChatComposerDraft(draftScope)).toBe(draft)
  } finally {
    authority.stop()
    release()
    hook.unmount()
    clearNativeChatComposerDraftsForTests()
  }
})
