// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import type * as HostCapabilityModule from '@/runtime/structured-agent-session-host-capability'
import type * as NativeChatMessageListModule from './NativeChatMessageList'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)

vi.mock('@/lib/structured-agent-session-launch', () =>
  moduleFactories.structuredAgentSessionLaunch()
)
vi.mock('@/runtime/structured-agent-session-client', () =>
  moduleFactories.structuredAgentSessionClient()
)
vi.mock('./use-structured-agent-session', () => moduleFactories.useStructuredAgentSession())
vi.mock('./use-native-chat-font-size', () => moduleFactories.useNativeChatFontSize())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())
vi.mock('@/runtime/structured-agent-session-host-capability', async (importOriginal) => {
  const original = await importOriginal<typeof HostCapabilityModule>()
  const { AGENT_SESSION_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY } =
    await import('../../../../shared/agent-session-continue-interrupted-capability')
  return {
    ...original,
    useStructuredAgentSessionHostCapabilityState: (
      ...args: Parameters<typeof original.useStructuredAgentSessionHostCapabilityState>
    ) =>
      args[1] === AGENT_SESSION_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY
        ? 'supported'
        : original.useStructuredAgentSessionHostCapabilityState(...args)
  }
})
// The real list, collapsed, over the journal the controller hands it.
vi.mock('./NativeChatMessageList', async (importOriginal) => {
  const { NativeChatMessageList } = await importOriginal<typeof NativeChatMessageListModule>()
  const { projectStructuredAgentSessionMessages } =
    await import('../../../../shared/structured-agent-session-message-projection')
  const { selectStructuredAgentSettledTurns } =
    await import('../../../../shared/structured-agent-session-turn-timing')
  return {
    NativeChatMessageList: (props: React.ComponentProps<typeof NativeChatMessageList>) => {
      const items = props.journalItems ?? []
      return (
        <NativeChatMessageList
          {...props}
          session={{
            ...props.session,
            messages: projectStructuredAgentSessionMessages(items, [], [])
          }}
          settledTurns={selectStructuredAgentSettledTurns(items)}
        />
      )
    }
  }
})

import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatStructuredSession } from './NativeChatStructuredSession'
import { agentJournalItemKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalStatusItem
} from '../../../../shared/agent-session-journal-types'
import { agentSessionOrcaStopRowBody } from '../../../../shared/agent-session-orca-stop'
import { withNativeChatCutTurnNotices } from '../../../../shared/native-chat-cut-turn-notice'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'

let sequence = 0
const item = (itemId: string, body: AgentJournalItemBody, turnItemId?: string) => ({
  itemId,
  revision: 1,
  sequence: ++sequence,
  observedAt: sequence,
  turnScope: turnItemId ? { kind: 'turn' as const, turnItemId } : { kind: 'thread' as const },
  body
})
const work = { type: 'tool-call', name: 'shell', input: {}, state: 'completed' } as const

/** A turn cut short after some work, and the row a host wrote about it. */
function cutTurn(id: string, row: [clientMessageId: string, body: AgentJournalStatusItem]) {
  const turn = agentJournalItemKey({ provider: 'codex', threadId: 't', turnId: id, ordinal: 1 })
  return [
    item(`user-${id}`, { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] }),
    item(turn, { kind: 'turn', turnId: id, state: 'interrupted', startedAt: 1, completedAt: 5 }),
    item(`work-${id}`, { kind: 'message', role: 'assistant', blocks: [work] }, turn),
    item(agentJournalItemKey({ provider: 'orca', clientMessageId: row[0] }), row[1], turn)
  ]
}

const AGENT_CRASH =
  'Codex stopped while this response was in progress. You can continue in this conversation.'
const agentExit: AgentJournalStatusItem = { kind: 'status', text: AGENT_CRASH, tone: 'error' }

const cutChat = withNativeChatCutTurnNotices([
  // An older host's reopen row, red and blaming the agent.
  ...cutTurn('old', ['stale-session:s:death-0-1', agentExit]),
  ...cutTurn('quit', ['stale-session:s:shutdown-1-g1', agentSessionOrcaStopRowBody('crash')]),
  // The agent's own exit while Orca ran.
  ...cutTurn('exit', ['provider-exit:s:2:g2', agentExit]),
  // A reopen found the agent gone and nothing says why.
  ...cutTurn('gone', ['stale-session:s:death-3-9', agentSessionOrcaStopRowBody(undefined)])
])

const restoreViewport = installNativeChatMessageListTestViewport()
afterAll(restoreViewport)
afterEach(() => {
  cleanup()
  resetStructuredSessionMocks()
})

it('keeps each collapsed cut explained once, and offers one Continue, in the neutral card', () => {
  mocks.journalItems = [...cutChat]
  render(
    <TooltipProvider>
      <NativeChatStructuredSession
        isVisible
        isFocusedGroup
        tabId="orca-stop-tab"
        sessionId="orca-stop-session"
        // A paired server with no name to show.
        target={{ kind: 'environment', environmentId: 'env-unnamed' }}
        agent="codex"
      />
    </TooltipProvider>
  )

  const collapsed = { name: 'Toggle turn details', expanded: false }
  expect(screen.getAllByRole('button', collapsed)).toHaveLength(4)
  // A known cause keeps its wording.
  screen.getByText(/^Orca on the remote server stopped unexpectedly while this response/)
  // The agent's own exit stays red.
  expect(screen.getByText(AGENT_CRASH).parentElement?.parentElement).toHaveClass('text-destructive')
  // Throws on a second Continue anywhere in the pane, such as the old row above the composer.
  const button = screen.getByRole('button', { name: 'Continue' })
  // The older host's row reads neutral too, with no Continue, which that host would refuse.
  expect(
    screen.getAllByText(/^This response was interrupted/).map((row) => row.textContent)
  ).toEqual([
    'This response was interrupted. You can continue in this conversation.',
    'This response was interrupted.'
  ])
  const sentence = screen.getByText('This response was interrupted.')
  expect(sentence.parentElement).toContainElement(button)
  expect(sentence.parentElement?.parentElement).toHaveClass('text-chat-foreground-faint')
})
