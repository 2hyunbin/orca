import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { makeAgentStatusStoreWiring } from '../../src/main/runtime/agent-status-store-wiring.test-fixture'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-types'
import { getDefaultWorkspaceSession } from '../../src/shared/constants'
import type { WorkspaceSessionState } from '../../src/shared/workspace-session-state-types'

const PTY_ID = 'pty-0'
const WORKTREE_ID = 'workspace-0'
const TAB_ID = 'host-tab-0'
const LEAF_ID = '00000000-0000-4000-8000-000000000000'

type RuntimeInternals = {
  ptysById: Map<string, { lastAgentStatusRichInvalidatedAtEpochMs: number | null }>
  resetTrackedTerminalStateForProviderGeneration: (ptyId: string) => void
}

type Harness = {
  internals: RuntimeInternals
  publications: RuntimeMobileSessionTabsResult[]
  runtime: OrcaRuntimeService
  unsubscribe: () => void
}

/** One saved `Cursor Agent` terminal bound to its pane, so hook reports reach the phone row. */
function createHarness(): Harness {
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          ptyId: PTY_ID,
          worktreeId: WORKTREE_ID,
          title: 'Cursor Agent',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the paths under test read only the workspace session and settings of this partial Store.
  const store = {
    getWorkspaceSession: () => session,
    setWorkspaceSession: () => {},
    getSettings: () => ({})
  } as never
  const statusWiring = makeAgentStatusStoreWiring()
  const runtime = new OrcaRuntimeService(store, undefined, statusWiring.deps)
  const uninstallStatusRepublish = statusWiring.attach(runtime)
  runtime.registerPty(PTY_ID, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_ID })
  const publications: RuntimeMobileSessionTabsResult[] = []
  const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
    publications.push(structuredClone(snapshot))
  })
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test reaches protected runtime members that exist on OrcaRuntimeService.
    internals: runtime as unknown as RuntimeInternals,
    publications,
    runtime,
    unsubscribe: () => {
      unsubscribe()
      uninstallStatusRepublish()
      statusWiring.statusStore.stop()
    }
  }
}

/** Rich status now reaches phones only through the hook-status store. */
function reportHookStatus(harness: Harness, payload: Record<string, string>): void {
  harness.runtime.onPtyData(PTY_ID, `\x1b]9999;${JSON.stringify(payload)}\x07`, Date.now())
}

function setRichStatus(
  harness: Harness,
  args: { agentType?: 'claude' | 'cursor'; prompt: string }
): void {
  reportHookStatus(harness, {
    state: 'working',
    prompt: args.prompt,
    agentType: args.agentType ?? 'cursor'
  })
}

function emitTitle(harness: Harness, title: string, at = Date.now()): void {
  harness.runtime.onPtyData(PTY_ID, `\x1b]0;${title}\x07`, at)
  vi.advanceTimersByTime(50)
}

function latestStatus(harness: Harness) {
  const terminal = harness.publications.at(-1)?.tabs[0]
  return terminal?.type === 'terminal' ? terminal.agentStatus : undefined
}

describe('session-tabs rich-status boundaries', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not renew a previous task across a done-to-working title boundary', () => {
    const harness = createHarness()
    const firstWorkingAt = Date.now()
    setRichStatus(harness, { prompt: 'previous task' })
    emitTitle(harness, '⠋ Cursor Agent', firstWorkingAt)
    vi.advanceTimersByTime(1)
    emitTitle(harness, 'bash')
    harness.publications.length = 0

    vi.advanceTimersByTime(1)
    const nextWorkingAt = Date.now()
    emitTitle(harness, '⠙ Cursor Agent', nextWorkingAt)
    expect(latestStatus(harness)).toMatchObject({
      state: 'working',
      prompt: '',
      updatedAt: nextWorkingAt,
      stateStartedAt: nextWorkingAt
    })
    harness.unsubscribe()
  })

  it('preserves the same task across a neutral title', () => {
    const harness = createHarness()
    const workingAt = Date.now()
    setRichStatus(harness, { prompt: 'current task' })
    emitTitle(harness, '⠋ Cursor Agent', workingAt)

    harness.publications.length = 0
    vi.advanceTimersByTime(1)
    emitTitle(harness, 'Terminal')
    expect(latestStatus(harness)).toMatchObject({
      state: 'working',
      prompt: 'current task',
      updatedAt: workingAt,
      stateStartedAt: workingAt
    })

    harness.publications.length = 0
    vi.advanceTimersByTime(1)
    const resumedWorkingAt = Date.now()
    emitTitle(harness, '⠙ Cursor Agent', resumedWorkingAt)
    expect(latestStatus(harness)).toMatchObject({
      state: 'working',
      prompt: 'current task',
      updatedAt: resumedWorkingAt,
      stateStartedAt: workingAt
    })
    harness.unsubscribe()
  })

  it('does not resurrect a task after neutral then shell titles', () => {
    const harness = createHarness()
    setRichStatus(harness, { prompt: 'completed task' })
    emitTitle(harness, '⠋ Cursor Agent')
    vi.advanceTimersByTime(1)
    emitTitle(harness, 'Terminal')
    vi.advanceTimersByTime(1)
    emitTitle(harness, 'bash')
    harness.publications.length = 0

    vi.advanceTimersByTime(1)
    const nextWorkingAt = Date.now()
    emitTitle(harness, '⠙ Cursor Agent', nextWorkingAt)
    expect(latestStatus(harness)).toMatchObject({
      state: 'working',
      prompt: '',
      updatedAt: nextWorkingAt,
      stateStartedAt: nextWorkingAt
    })
    harness.unsubscribe()
  })

  it('does not carry a stale question into the next title interval', () => {
    const harness = createHarness()
    const firstWorkingAt = Date.now()
    reportHookStatus(harness, {
      state: 'waiting',
      prompt: 'previous question',
      interactivePrompt: '{"question":"previous question"}',
      agentType: 'cursor'
    })
    emitTitle(harness, 'Cursor Agent needs confirmation', firstWorkingAt)
    vi.advanceTimersByTime(1)
    emitTitle(harness, 'bash')
    harness.publications.length = 0

    vi.advanceTimersByTime(1)
    emitTitle(harness, '⠋ Cursor Agent')
    expect(latestStatus(harness)).toMatchObject({ state: 'working', prompt: '' })
    expect(latestStatus(harness)).not.toHaveProperty('interactivePrompt')
    harness.unsubscribe()
  })

  it('keeps a retained OSC question visible under a shell title until the next agent interval', () => {
    const harness = createHarness()
    reportHookStatus(harness, {
      state: 'waiting',
      prompt: 'current question',
      interactivePrompt: 'question-payload',
      agentType: 'cursor'
    })

    emitTitle(harness, 'bash')
    expect(latestStatus(harness)).toMatchObject({
      state: 'waiting',
      interactivePrompt: 'question-payload'
    })

    harness.publications.length = 0
    vi.advanceTimersByTime(1)
    emitTitle(harness, '⠋ Cursor Agent')
    expect(latestStatus(harness)).toMatchObject({ state: 'working', prompt: '' })
    expect(latestStatus(harness)).not.toHaveProperty('interactivePrompt')
    harness.unsubscribe()
  })

  it('does not resurrect retained status after an identity-only owner change', () => {
    const harness = createHarness()
    reportHookStatus(harness, { state: 'working', prompt: 'retained task', agentType: 'codex' })
    vi.advanceTimersByTime(50)
    emitTitle(harness, '⠋ Codex working')
    harness.publications.length = 0

    vi.advanceTimersByTime(1)
    emitTitle(harness, 'Cursor Agent')
    expect(latestStatus(harness)).toMatchObject({ state: 'done', prompt: '' })
    harness.unsubscribe()
  })

  it('does not renew rich status from a replaced provider generation', () => {
    const harness = createHarness()
    const firstWorkingAt = Date.now()
    setRichStatus(harness, { prompt: 'previous provider task' })
    emitTitle(harness, '⠋ Cursor Agent', firstWorkingAt)
    harness.internals.resetTrackedTerminalStateForProviderGeneration(PTY_ID)
    harness.publications.length = 0

    vi.advanceTimersByTime(1)
    const replacementWorkingAt = Date.now()
    emitTitle(harness, '⠙ Cursor Agent', replacementWorkingAt)
    expect(latestStatus(harness)).toMatchObject({
      state: 'working',
      prompt: '',
      updatedAt: replacementWorkingAt,
      stateStartedAt: replacementWorkingAt
    })
    harness.unsubscribe()
  })

  it('keeps invalidation across an identity-only owner change', () => {
    const harness = createHarness()
    setRichStatus(harness, { prompt: 'previous owner task', agentType: 'claude' })
    emitTitle(harness, '⠋ Claude working')
    harness.publications.length = 0

    vi.advanceTimersByTime(1)
    const identityChangeAt = Date.now()
    emitTitle(harness, 'Cursor Agent', identityChangeAt)
    expect(harness.internals.ptysById.get(PTY_ID)?.lastAgentStatusRichInvalidatedAtEpochMs).toBe(
      identityChangeAt
    )
    // The hook row's agent type keeps the row addressable as `done`; the old task must not return.
    expect(latestStatus(harness)).toMatchObject({ state: 'done', prompt: '' })
    harness.unsubscribe()
  })
})
