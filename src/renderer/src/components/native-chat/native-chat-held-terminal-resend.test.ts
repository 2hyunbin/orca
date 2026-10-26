import { afterEach, expect, it, vi } from 'vitest'
import { heldTerminalMessageRetry } from './native-chat-held-terminal-resend'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  type StructuredAgentSessionState
} from '../../../../shared/structured-agent-session-reducer'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/structured-agent-session-start-failure-row-key'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session-journal-item-key'
import {
  agentSessionSendBodyFingerprint,
  structuredAgentSessionSendBody
} from '../../../../shared/structured-agent-session-send-mutation'
import {
  clearStructuredAgentSessionPendingSends,
  publishStructuredAgentSessionSends
} from './structured-agent-session-pending-sends'
const body = structuredAgentSessionSendBody(
  'Use $review on this',
  [{ path: '/image.png', previewUri: '' }],
  [{ name: 'review', path: '/review/SKILL.md' }]
)
const noticeId = agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('old'))
function setup() {
  let current: StructuredAgentSessionState = {
    ...EMPTY_STRUCTURED_AGENT_SESSION,
    epoch: 'epoch',
    items: [
      { itemId: agentJournalSubmissionKey('old'), sequence: 1, revision: 1, observedAt: 10, body }
    ],
    submissions: [
      {
        clientMessageId: 'old',
        fence: 1,
        payloadFingerprint: agentSessionSendBodyFingerprint('session', body),
        dispatchState: 'rejected',
        providerItemId: null,
        reason: 'terminal',
        submittedAt: 10,
        resolvedAt: 20
      }
    ]
  }
  let valid = true,
    floor = 0
  const send = vi.fn(() => true)
  const retry = () =>
    heldTerminalMessageRetry(
      () => current,
      noticeId,
      'session',
      send,
      () => valid,
      () => floor
    )
  return {
    send,
    retry,
    get state() {
      return current
    },
    replace: (state: StructuredAgentSessionState) => {
      current = state
    },
    invalidate: () => {
      valid = false
    },
    clear: () => {
      floor = 3
    }
  }
}
afterEach(() => clearStructuredAgentSessionPendingSends('session'))
it('resends the rejected text, attachment and picked skill once through the normal sender', () => {
  const p = setup(),
    retry = p.retry()
  retry?.()
  retry?.()
  expect(p.send).toHaveBeenCalledExactlyOnceWith(
    'Use $review on this',
    [{ path: '/image.png', previewUri: '' }],
    { skills: body.skills }
  )
})
it.each(['sending', 'recorded', 'journal', 'epoch', 'clear', 'unmount'] as const)(
  'does not duplicate a manual resend or stale context: %s',
  (kind) => {
    const p = setup(),
      retry = p.retry()
    if (kind === 'sending' || kind === 'recorded') {
      publishStructuredAgentSessionSends('session', {
        entries: [
          {
            clientMessageId: 'manual',
            sessionId: 'session',
            body,
            previewUris: [],
            queuedAt: 30,
            phase: kind,
            issued: true
          }
        ]
      })
    }
    if (kind === 'journal') {
      p.replace({
        ...p.state,
        submissions: [
          ...p.state.submissions,
          {
            ...p.state.submissions[0],
            clientMessageId: 'manual',
            dispatchState: 'accepted',
            submittedAt: 30
          }
        ]
      })
    }
    if (kind === 'epoch') {
      p.replace({ ...p.state, epoch: 'new' })
    }
    if (kind === 'clear') {
      p.clear()
    }
    if (kind === 'unmount') {
      p.invalidate()
    }
    retry?.()
    expect(p.send).not.toHaveBeenCalled()
    if (kind === 'journal' || kind === 'recorded' || kind === 'sending' || kind === 'clear') {
      expect(p.retry()).toBeNull()
    }
  }
)
