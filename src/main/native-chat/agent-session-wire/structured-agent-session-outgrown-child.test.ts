// An idle child launched under a different permission mode is replaced before the next send.

import { describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { retireOutgrownStructuredAgentSessionChild } from './structured-agent-session-outgrown-child'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'
import { structuredAgentSessionLaunchPermission } from './structured-agent-session-launch-permission'
import type { AgentChatPermissionMode } from '../../../shared/agent-chat-permission-mode'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import type {
  AgentJournalItemBody,
  AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { StructuredAgentSessionChildWorkReads } from './structured-agent-session-idle-sweep'

type Row = { itemId: string; fence: number; agentId?: string; body: AgentJournalItemBody }

const childAt = (
  overrides: Partial<StructuredAgentSessionProviderChild> = {}
): StructuredAgentSessionProviderChild => ({
  generation: 'generation-2',
  fence: 2,
  phase: 'ready',
  permissionMode: 'ask',
  ...overrides
})
const conversation = (
  input: {
    child?: StructuredAgentSessionProviderChild | null
    items?: Row[]
    activeTurnId?: string
    newestTurnEndedAt?: number
  } = {}
) => {
  const items = input.items ?? []
  return {
    child: input.child === undefined ? childAt() : input.child,
    journal: {
      visitItems: (visit: (itemId: string, sequence: number, body: AgentJournalItemBody) => void) =>
        items.forEach((item, index) => visit(item.itemId, index, item.body)),
      activeTurnId: () => input.activeTurnId ?? null,
      newestTurn: (): AgentJournalTurnLifecycle | null =>
        input.newestTurnEndedAt === undefined
          ? null
          : { turnId: 'turn-0', state: 'completed', completedAt: input.newestTurnEndedAt }
    }
  }
}

describe('retireOutgrownStructuredAgentSessionChild', () => {
  it('keeps a signed-out child until normal failure settlement closes it', async () => {
    const stopAgent = vi.fn(async () => undefined)
    await retireOutgrownStructuredAgentSessionChild(
      'session',
      conversation({
        child: childAt({ permissionMode: undefined }),
        items: [
          {
            itemId: 'signed-out',
            fence: 2,
            body: {
              kind: 'status',
              ...agentSessionFailureWords(agentSessionFailureFact('notSignedIn'), {
                surface: 'row'
              })
            }
          }
        ]
      }),
      {
        work: {
          childWork: () => [],
          hasOpenDispatch: () => false,
          providerHoldsDispatch: () => false
        },
        launchPermission: async () => 'full-access',
        stopAgent,
        logger: { warn: vi.fn(), error: vi.fn() }
      }
    )
    expect(stopAgent).not.toHaveBeenCalled()
  })
  const liveChildWork: AgentChildWorkView = {
    id: 'subagent-1',
    kind: 'agent',
    state: 'working',
    membership: 'live',
    firstObservedAt: 0,
    observedAt: 0,
    stoppable: false,
    invocation: { invocationId: 'spawn-subagent-1', generation: 1 }
  }
  const idle: StructuredAgentSessionChildWorkReads = {
    childWork: () => [],
    hasOpenDispatch: () => false,
    providerHoldsDispatch: () => false
  }
  const outgrown = { child: childAt({ permissionMode: 'ask' }) }
  const retire = async (
    input: Parameters<typeof conversation>[0],
    work: Partial<typeof idle> = {},
    stopAgent = vi.fn(async () => undefined),
    launchPermission: () => Promise<AgentChatPermissionMode | null> = async () => 'full-access'
  ) => {
    const warn = vi.fn()
    await retireOutgrownStructuredAgentSessionChild('session', conversation(input), {
      work: { ...idle, ...work },
      launchPermission,
      stopAgent,
      logger: { warn, error: vi.fn() }
    })
    return { stopAgent, warn }
  }

  it('keeps it while it owes work the idle sweep also protects', async () => {
    // A pending prompt is the shared check's too; the idle sweep's tests cover that case.
    for (const kept of [
      await retire({ ...outgrown, activeTurnId: 'turn-1' }),
      await retire(outgrown, { childWork: () => [liveChildWork] }),
      await retire(outgrown, { hasOpenDispatch: () => true }),
      await retire(outgrown, { providerHoldsDispatch: () => true })
    ]) {
      expect(kept.stopAgent).not.toHaveBeenCalled()
    }
  })

  it('keeps it while a result that settled after the last turn may still wake it', async () => {
    const settled: AgentChildWorkView = {
      ...liveChildWork,
      state: 'done',
      membership: 'settled',
      outcome: 'succeeded',
      settledAt: 200
    }
    const after = await retire(
      { ...outgrown, newestTurnEndedAt: 100 },
      { childWork: () => [settled] }
    )
    expect(after.stopAgent).not.toHaveBeenCalled()
    const before = await retire(
      { ...outgrown, newestTurnEndedAt: 300 },
      { childWork: () => [settled] }
    )
    expect(before.stopAgent).toHaveBeenCalledWith('session')
  })

  it('logs a stop that fails and lets the send go on', async () => {
    const { warn } = await retire(
      outgrown,
      {},
      vi.fn(async () => {
        throw new Error('exit not proven')
      })
    )
    expect(warn).toHaveBeenCalledWith(
      'replacing an outgrown agent failed',
      expect.objectContaining({ sessionId: 'session' })
    )
  })

  describe('a child launched with another permission mode', () => {
    const now = (mode: AgentChatPermissionMode) => vi.fn(async () => mode)
    const askChild = { child: childAt({ permissionMode: 'ask' }) }

    it('is stopped once, and one launched with the current mode is kept', async () => {
      expect(
        (await retire(askChild, {}, undefined, now('full-access'))).stopAgent
      ).toHaveBeenCalledWith('session')
      expect((await retire(askChild, {}, undefined, now('ask'))).stopAgent).not.toHaveBeenCalled()
    })

    it('is kept while it owes work, as a signed-out one is', async () => {
      for (const kept of [
        await retire({ ...askChild, activeTurnId: 'turn-1' }, {}, undefined, now('auto')),
        await retire(askChild, { childWork: () => [liveChildWork] }, undefined, now('auto')),
        await retire({ ...askChild, items: [pendingPrompt] }, {}, undefined, now('auto'))
      ]) {
        expect(kept.stopAgent).not.toHaveBeenCalled()
      }
    })

    it('is kept while starting, or for an agent with no modes', async () => {
      const starting = { child: childAt({ permissionMode: 'ask', phase: 'starting' }) }
      expect((await retire(starting, {}, undefined, now('auto'))).stopAgent).not.toHaveBeenCalled()
      expect(
        (await retire(askChild, {}, undefined, async () => null)).stopAgent
      ).not.toHaveBeenCalled()
    })

    // The check reads the same mode a start launches with, so each start ends the restarts.
    describe('against the mode a start launches with', () => {
      // The saved catalog the probe keeps from `claude` 2.1.280: the default row folded into the
      // row it resolves to, every row but haiku listed as running auto.
      const listed = [
        { id: 'opus[1m]', isDefault: true, supportsAutoMode: true },
        { id: 'sonnet', isDefault: false, supportsAutoMode: true },
        { id: 'haiku', isDefault: false }
      ]
      const catalog = (rows: typeof listed) => ({
        read: vi.fn(async () => ({
          origin: 'probe' as const,
          fetchedAt: 1,
          models: rows.map((row) => ({ ...row, label: row.id, efforts: [] }))
        })),
        recordLiveListing: vi.fn(),
        prewarm: vi.fn(async () => undefined),
        stop: vi.fn(),
        providerStarted: vi.fn()
      })
      const launch = (options: Record<string, string>, rows = listed) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch mode reads only the record's id, agent and options.
        const record = { sessionId: 'session', provider: 'claude', options } as AgentSessionRecord
        return () =>
          structuredAgentSessionLaunchPermission(
            { agents: claudeAndCodexDeclared(), modelCatalog: catalog(rows) },
            record
          )
      }
      const stoppedAfterLaunch = async (
        launched: AgentChatPermissionMode,
        current: () => Promise<AgentChatPermissionMode | null>
      ) =>
        (await retire({ child: childAt({ permissionMode: launched }) }, {}, undefined, current))
          .stopAgent.mock.calls.length > 0

      it('restarts Full access or Accept edits into Ask when auto is not confirmed', async () => {
        const unconfirmed = [
          launch({ model: 'haiku', permissionMode: 'auto' }),
          launch({ permissionMode: 'auto' }, [{ id: 'opus[1m]', isDefault: true }])
        ]
        for (const autoPick of unconfirmed) {
          await expect(autoPick()).resolves.toBe('ask')
          expect(await stoppedAfterLaunch('full-access', autoPick)).toBe(true)
          expect(await stoppedAfterLaunch('accept-edits', autoPick)).toBe(true)
          expect(await stoppedAfterLaunch('ask', autoPick)).toBe(false)
        }
      })

      it('never restarts a child it just started, from an alias or a resolved id', async () => {
        const records: Record<string, string>[] = [
          { permissionMode: 'auto' },
          { model: 'default', permissionMode: 'auto' },
          { model: 'opus[1m]', permissionMode: 'auto' },
          { model: 'sonnet', permissionMode: 'auto' },
          { model: 'haiku', permissionMode: 'auto' },
          { model: 'claude-opus-5-5[1m]', permissionMode: 'auto' }
        ]
        const runsAuto = [true, true, true, true, false, false]
        for (const [index, options] of records.entries()) {
          const current = launch(options)
          const launched = await current()
          expect(launched).toBe(runsAuto[index] ? 'auto' : 'ask')
          expect(await stoppedAfterLaunch(launched!, current)).toBe(false)
        }
      })

      // A resolved id launches Ask; the start reports the listed alias, so one restart reaches auto.
      it('settles after one restart once a resolved id is reported as its alias', async () => {
        const first = await launch({ model: 'claude-opus-5-5[1m]', permissionMode: 'auto' })()
        const reported = launch({ model: 'opus[1m]', permissionMode: 'auto' })
        expect(await stoppedAfterLaunch(first!, reported)).toBe(true)
        expect(await stoppedAfterLaunch((await reported())!, reported)).toBe(false)
      })
    })

    it('never reads the mode for a child launched with none', async () => {
      const current = now('full-access')
      expect(
        (await retire({ child: childAt({ permissionMode: undefined }) }, {}, undefined, current))
          .stopAgent
      ).not.toHaveBeenCalled()
      expect(current).not.toHaveBeenCalled()
    })
  })
})

const pendingPrompt: Row = {
  itemId: 'approval-1',
  fence: 2,
  body: {
    kind: 'approval',
    title: 'Run a command',
    detail: null,
    options: [],
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
}
