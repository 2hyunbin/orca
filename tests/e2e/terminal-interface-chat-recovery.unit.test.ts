// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import {
  LEFT,
  RIGHT,
  ownershipFixture as mocks,
  makeFixture,
  useFixture,
  terminalChatProcessRows
} from '../../src/renderer/src/components/terminal-pane/terminal-chat-ownership.test-fixture'
import { TerminalInterfaceAuthority } from '../../src/main/agent-hooks/server/terminal-interface-authority'
import { inspectPosixTerminalInterface } from '../../src/main/providers/terminal-interface-process-evidence'
import { resolveRemoteForegroundEvidence } from '../../src/main/providers/agent-foreground-process'
import type { TerminalProcessInspection } from '../../src/shared/terminal-process-inspection'
import type { TerminalInterfaceBinding } from '../../src/shared/terminal-interface-observation'
import {
  updateNativeChatComposerDraft,
  readNativeChatComposerDraft,
  clearNativeChatComposerDraftsForTests
} from '../../src/renderer/src/components/native-chat/native-chat-composer-draft-store'
import {
  applyTerminalInterfaceSnapshot,
  registerTerminalInterfacePresentation
} from '../../src/renderer/src/components/native-chat/terminal-interface-presentation'
import { makePaneKey } from '../../src/shared/stable-pane-id'
import { useAppStore } from '../../src/renderer/src/store'

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
