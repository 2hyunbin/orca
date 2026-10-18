import { describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hooks/server'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { makeStructuredAgentStatusSubject } from '../../../shared/agent-status-subject'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import type { TerminalSideEffectFact } from '../../../shared/terminal-side-effect-facts'
import type { SmartStampFields } from '../../../shared/sidebar-list/sort-stamps'
import { SortStampsProducer, type SortStampsStore } from './sort-stamps-producer'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

const WT = 'repo-1::/tmp/a'
const FOLDER_ID = '11111111-1111-4111-8111-111111111111'
const FOLDER = `folder:${FOLDER_ID}`
const PANE = 'tab-a:22222222-2222-4222-8222-222222222222'
const TITLE_PANE = 'tab-t:33333333-3333-4333-8333-333333333333'
const T0 = 1_000_000

type Stamps = { lastActivityAt: number } & SmartStampFields

function createHarness() {
  let now = T0
  const meta = new Map<string, Stamps>([[WT, { lastActivityAt: 0 }]])
  const folders = new Map<string, Stamps>([[FOLDER_ID, { lastActivityAt: 0 }]])
  const writes: string[] = []
  const exits = new Map<string, () => void>()
  let listener: (event: RuntimeClientEvent) => void = () => {}
  const store: SortStampsStore = {
    getWorktreeMeta: (id) => meta.get(id),
    setWorktreeMeta: (id, updates) => {
      writes.push(id)
      meta.set(id, { ...meta.get(id), ...updates })
    },
    getFolderWorkspace: (id) => folders.get(id),
    updateFolderWorkspace: (id, updates) => {
      writes.push(`folder:${id}`)
      folders.set(id, { ...folders.get(id), ...updates })
    }
  }
  const producer = new SortStampsProducer({
    store: () => store,
    resolveTabWorktreeId: (tabId) => (tabId === 'tab-t' ? WT : undefined),
    subscribeToPtyExit: (ptyId, onExit) => {
      exits.set(ptyId, onExit)
      return () => exits.delete(ptyId)
    },
    onClientEvent: (next, options) => {
      expect(options.consumesTerminalSideEffects).toBe(true)
      listener = next
      return () => {}
    },
    now: () => now
  })
  const server = new AgentHookServer()
  return {
    producer,
    server,
    meta,
    folders,
    writes,
    exits,
    advance: (ms: number) => {
      now += ms
      return now
    },
    get now() {
      return now
    },
    sideEffects: (facts: TerminalSideEffectFact[], extra: { replay?: true; pane?: string } = {}) =>
      listener({
        type: 'terminalSideEffects',
        batch: {
          ptyId: 'pty-t',
          seq: 1,
          facts,
          worktreeId: WT,
          paneKey: extra.pane ?? TITLE_PANE,
          ...(extra.replay ? { replay: true } : {})
        }
      })
  }
}

function hook(
  server: AgentHookServer,
  state: 'working' | 'blocked' | 'waiting' | 'done',
  worktreeId = WT
): void {
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-a',
    worktreeId,
    payload: { state, prompt: 'task', agentType: 'codex' }
  })
}

function title(rawTitle: string): Extract<TerminalSideEffectFact, { kind: 'title' }> {
  return { kind: 'title', normalizedTitle: rawTitle, rawTitle }
}

describe('SortStampsProducer: hook agents', () => {
  it('stamps prompt, finish and needs-input, and holds Done until the next prompt', () => {
    const h = createHarness()
    h.producer.attachAgentStatusStore(h.server)

    hook(h.server, 'working')
    expect(h.meta.get(WT)).toEqual({ lastActivityAt: T0, smartTier: 'working', smartAt: T0 })

    const finishedAt = h.advance(20_000)
    hook(h.server, 'done')
    expect(h.meta.get(WT)).toEqual({
      lastActivityAt: finishedAt,
      smartTier: 'done',
      smartAt: finishedAt
    })

    const promptedAt = h.advance(20_000)
    hook(h.server, 'working')
    const askedAt = h.advance(20_000)
    hook(h.server, 'blocked')
    expect(h.meta.get(WT)).toEqual({
      lastActivityAt: askedAt,
      smartTier: 'needs-you',
      smartAt: askedAt
    })
    expect(promptedAt).toBeLessThan(askedAt)

    // Resuming after the approval is the same turn: Working, no Recent stamp, the ask's time.
    h.advance(20_000)
    hook(h.server, 'working')
    expect(h.meta.get(WT)).toEqual({
      lastActivityAt: askedAt,
      smartTier: 'working',
      smartAt: askedAt
    })
  })

  it('never stamps running to running, and throttles Recent while tiers apply at once', () => {
    const h = createHarness()
    h.producer.attachAgentStatusStore(h.server)
    hook(h.server, 'working')
    const writes = h.writes.length
    h.advance(1_000)
    hook(h.server, 'working')
    expect(h.writes).toHaveLength(writes)

    const doneAt = h.advance(1_000)
    hook(h.server, 'done')
    expect(h.meta.get(WT)).toEqual({ lastActivityAt: T0, smartTier: 'done', smartAt: doneAt })
  })

  it('seeds a status present at attach without writing', () => {
    const h = createHarness()
    hook(h.server, 'working')
    h.producer.attachAgentStatusStore(h.server)
    expect(h.writes).toEqual([])

    // The seeded pane is known, so its finish is a transition.
    const doneAt = h.advance(20_000)
    hook(h.server, 'done')
    expect(h.meta.get(WT)).toEqual({ lastActivityAt: doneAt, smartTier: 'done', smartAt: doneAt })
  })

  it('drops to Rest without a Recent stamp when the agent’s row goes', () => {
    const h = createHarness()
    h.producer.attachAgentStatusStore(h.server)
    hook(h.server, 'working')
    h.advance(20_000)
    hook(h.server, 'done')
    const { lastActivityAt } = h.meta.get(WT)!
    h.advance(20_000)
    h.server.clearPaneState(PANE)
    expect(h.meta.get(WT)).toEqual({ lastActivityAt, smartTier: undefined, smartAt: undefined })
  })

  it('stamps a structured chat session through the same store', () => {
    const h = createHarness()
    h.producer.attachAgentStatusStore(h.server)
    const subject = makeStructuredAgentStatusSubject(
      { executionHostId: 'local', wslDistro: null, workspaceId: FOLDER, workspaceKind: 'folder' },
      'structured-session-one'
    )
    const summary: AgentSessionStatusSummary = {
      sessionId: 'structured-session-one',
      workspaceId: FOLDER,
      agent: 'claude',
      status: 'working',
      hostExecutionOwned: true,
      latestPrompt: 'fix it',
      updatedAt: 100
    }
    h.server.ingestStructuredStatus(summary, subject)
    expect(h.folders.get(FOLDER_ID)).toEqual({
      lastActivityAt: T0,
      smartTier: 'working',
      smartAt: T0
    })
    const doneAt = h.advance(20_000)
    h.server.ingestStructuredStatus(
      { ...summary, status: 'idle', turnOutcome: 'success', updatedAt: 200 },
      subject
    )
    expect(h.folders.get(FOLDER_ID)).toEqual({
      lastActivityAt: doneAt,
      smartTier: 'done',
      smartAt: doneAt
    })
  })

  it('writes nothing for a workspace with no record', () => {
    const h = createHarness()
    h.producer.attachAgentStatusStore(h.server)
    hook(h.server, 'working', 'repo-1::/tmp/gone')
    expect(h.writes).toEqual([])
  })
})

describe('SortStampsProducer: terminal events', () => {
  it('stamps a bell, foreground or parked alike, and skips replays', () => {
    const h = createHarness()
    h.sideEffects([{ kind: 'bell' }], { replay: true })
    expect(h.writes).toEqual([])
    h.sideEffects([{ kind: 'bell' }])
    expect(h.meta.get(WT)).toEqual({ lastActivityAt: T0 })
  })

  it('stamps a terminal start', () => {
    const h = createHarness()
    h.producer.noteTerminalStarted(FOLDER)
    expect(h.folders.get(FOLDER_ID)).toEqual({ lastActivityAt: T0 })
  })

  it('turns a hookless agent’s titles into the same transitions', () => {
    const h = createHarness()
    h.producer.attachAgentStatusStore(h.server)
    // The first title seeds: it may be a terminal reattached after a restart.
    h.sideEffects([title('⠋ Codex working')])
    expect(h.writes).toEqual([])

    const doneAt = h.advance(20_000)
    h.sideEffects([title('Codex')])
    expect(h.meta.get(WT)).toEqual({ lastActivityAt: doneAt, smartTier: 'done', smartAt: doneAt })

    const promptAt = h.advance(20_000)
    h.sideEffects([title('⠋ Codex working')])
    expect(h.meta.get(WT)).toEqual({
      lastActivityAt: promptAt,
      smartTier: 'working',
      smartAt: promptAt
    })

    // The agent leaves with its terminal.
    h.advance(20_000)
    h.exits.get('pty-t')!()
    expect(h.meta.get(WT)).toEqual({
      lastActivityAt: promptAt,
      smartTier: undefined,
      smartAt: undefined
    })
  })

  it('ignores a cleared stale working title as a finish', () => {
    const h = createHarness()
    h.sideEffects([title('⠋ Codex working')])
    h.advance(20_000)
    h.sideEffects([{ ...title('Codex'), staleWorkingTitleClear: true }])
    expect(h.writes).toEqual([])
  })

  it('leaves a pane with hook rows to its hooks', () => {
    const h = createHarness()
    h.producer.attachAgentStatusStore(h.server)
    hook(h.server, 'working')
    const writes = h.writes.length
    h.sideEffects([title('⠋ Codex working')], { pane: PANE })
    h.advance(20_000)
    h.sideEffects([title('Codex')], { pane: PANE })
    expect(h.writes).toHaveLength(writes)
    expect(h.meta.get(WT)?.smartTier).toBe('working')
  })
})
