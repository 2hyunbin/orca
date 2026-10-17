import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentAccountSwitchSettings } from '../../../shared/agent-account-switch-settings'
import {
  answerAgentAccountSwitchPrompt,
  getAgentAccountSwitchPrompt,
  resetAgentAccountSwitchSessionsForTests,
  settleAgentAccountSwitch,
  type AccountSwitchSession,
  type AgentAccountSwitchHooks
} from './agent-account-switch-sessions'

type StoreStub = {
  settings: AgentAccountSwitchSettings
  ptyIdsByTabId: Record<string, string[]>
  terminalLayoutsByTabId: Record<string, { ptyIdsByLeafId?: Record<string, string> }>
  updateSettings: (updates: AgentAccountSwitchSettings) => Promise<void>
  queuePaneAccountRestarts: (ptyIds: string[], agent: string) => void
}

const store = vi.hoisted((): StoreStub => ({
  settings: {},
  ptyIdsByTabId: {},
  terminalLayoutsByTabId: {},
  updateSettings: vi.fn(async () => {}),
  queuePaneAccountRestarts: vi.fn()
}))
const toastSuccess = vi.hoisted(() => vi.fn())

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('sonner', () => ({ toast: { success: toastSuccess } }))

const leafOf = (ptyId: string): string => `leaf-${ptyId}`
const session = (ptyId: string): AccountSwitchSession => ({
  ptyId,
  worktreeId: 'wt-1',
  tabId: `tab-${ptyId}`,
  leafId: leafOf(ptyId)
})

/** Seeds each pane bound to its listed PTY. */
function bindPanes(ptyIds: string[]): void {
  for (const ptyId of ptyIds) {
    store.ptyIdsByTabId[`tab-${ptyId}`] = [ptyId]
    store.terminalLayoutsByTabId[`tab-${ptyId}`] = { ptyIdsByLeafId: { [leafOf(ptyId)]: ptyId } }
  }
}

function ask(args: {
  agent: 'claude' | 'codex'
  slotKey?: string
  ptyIds: string[]
  merge?: boolean
  previous?: string | null
  hooks?: AgentAccountSwitchHooks
}): ReturnType<typeof settleAgentAccountSwitch> {
  bindPanes(args.ptyIds)
  return settleAgentAccountSwitch({
    slotKey: args.slotKey ?? `${args.agent}:local`,
    isCurrent: () => true,
    agent: args.agent,
    reason: args.merge ? 'restored' : 'switch',
    sessions: args.ptyIds.map(session),
    previousAccountLabel: args.previous === undefined ? 'a@example.com' : args.previous,
    nextAccountLabel: 'b@example.com',
    merge: args.merge,
    hooks: args.hooks
  })
}

const listed = (): string[] | undefined =>
  getAgentAccountSwitchPrompt()?.sessions.map((entry) => entry.ptyId)

describe('agent account switch sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAgentAccountSwitchSessionsForTests()
    store.settings = {}
    store.ptyIdsByTabId = {}
    store.terminalLayoutsByTabId = {}
  })

  it('hands the unticked sessions to the agent keep hook when restarting the rest', () => {
    const keep = vi.fn()
    ask({ agent: 'codex', ptyIds: ['pty-1', 'pty-2', 'pty-3'], hooks: { keep } })

    answerAgentAccountSwitchPrompt('restart', { ptyIds: ['pty-2', 'pty-unlisted'] })

    expect(store.queuePaneAccountRestarts).toHaveBeenCalledWith(['pty-2'], 'codex')
    expect(keep).toHaveBeenCalledWith(['pty-1', 'pty-3'])
  })

  it.each(['claude', 'codex'] as const)(
    'restarts the pane PTY a %s session moved to while the question was open',
    (agent) => {
      ask({ agent, ptyIds: ['pty-old'] })
      // A reattach rebinds the same pane onto a new PTY.
      store.ptyIdsByTabId['tab-pty-old'] = ['pty-new']
      store.terminalLayoutsByTabId['tab-pty-old'] = {
        ptyIdsByLeafId: { [leafOf('pty-old')]: 'pty-new' }
      }

      answerAgentAccountSwitchPrompt('restart')

      expect(store.queuePaneAccountRestarts).toHaveBeenCalledWith(['pty-new'], agent)
    }
  )

  it.each(['claude', 'codex'] as const)(
    'queues nothing for a %s pane closed while the question was open',
    (agent) => {
      const keep = vi.fn()
      ask({ agent, ptyIds: ['pty-1'], hooks: { keep } })
      store.ptyIdsByTabId = {}
      store.terminalLayoutsByTabId = {}

      answerAgentAccountSwitchPrompt('restart')
      expect(store.queuePaneAccountRestarts).not.toHaveBeenCalled()
      expect(keep).not.toHaveBeenCalled()
    }
  )

  it('skips sessions the agent says no longer need the answer', () => {
    const keep = vi.fn()
    ask({
      agent: 'codex',
      ptyIds: ['pty-1', 'pty-2'],
      hooks: { keep, isStillOwed: (ptyId) => ptyId !== 'pty-1' }
    })

    answerAgentAccountSwitchPrompt('keep')

    expect(keep).toHaveBeenCalledWith(['pty-2'])
  })

  it("turns on the agent's own automatic restart when told not to ask again", () => {
    ask({ agent: 'codex', ptyIds: ['pty-1'] })

    answerAgentAccountSwitchPrompt('keep', { dontAskAgain: true })

    expect(store.updateSettings).toHaveBeenCalledWith({
      codexAccountSwitchRunningSessions: 'restart'
    })
  })

  it("applies the agent's saved setting without asking", () => {
    const keep = vi.fn()
    store.settings = { codexAccountSwitchRunningSessions: 'restart' }
    expect(ask({ agent: 'codex', ptyIds: ['pty-1', 'pty-2'] })).toBe('handled')
    expect(store.queuePaneAccountRestarts).toHaveBeenCalledWith(['pty-1', 'pty-2'], 'codex')
    expect(toastSuccess).toHaveBeenCalledWith('Restarting 2 Codex sessions on b@example.com')

    store.settings = { codexAccountSwitchRunningSessions: 'keep' }
    expect(ask({ agent: 'codex', ptyIds: ['pty-3'], hooks: { keep } })).toBe('show-confirmation')
    expect(keep).toHaveBeenCalledWith(['pty-3'])
    expect(getAgentAccountSwitchPrompt()).toBeNull()
  })

  it('reads each agent its own setting', () => {
    store.settings = { claudeAccountSwitchRunningSessions: 'restart' }

    expect(ask({ agent: 'codex', ptyIds: ['pty-1'] })).toBe('handled')
  })

  it('shows a waiting question once the one before it is answered', () => {
    ask({ agent: 'claude', ptyIds: ['pty-claude'] })
    ask({ agent: 'codex', ptyIds: ['pty-codex'] })

    expect(getAgentAccountSwitchPrompt()?.agent).toBe('claude')
    answerAgentAccountSwitchPrompt('keep')
    expect(getAgentAccountSwitchPrompt()?.agent).toBe('codex')
  })

  it('adds merged sessions to the open question without resetting it', () => {
    ask({ agent: 'codex', slotKey: 'codex:local:host', ptyIds: ['pty-1'], merge: true })
    const firstId = getAgentAccountSwitchPrompt()?.id

    ask({
      agent: 'codex',
      slotKey: 'codex:local:host',
      ptyIds: ['pty-1', 'pty-2'],
      merge: true,
      previous: 'c@example.com'
    })

    expect(getAgentAccountSwitchPrompt()?.id).toBe(firstId)
    expect(listed()).toEqual(['pty-1', 'pty-2'])
    expect(getAgentAccountSwitchPrompt()?.previousAccountLabel).toBeNull()
  })

  it('drops a superseded question', () => {
    expect(
      settleAgentAccountSwitch({
        slotKey: 'codex:local:host',
        isCurrent: () => false,
        agent: 'codex',
        reason: 'switch',
        sessions: [session('pty-1')],
        previousAccountLabel: null,
        nextAccountLabel: null
      })
    ).toBe('handled')
    expect(getAgentAccountSwitchPrompt()).toBeNull()
  })
})
