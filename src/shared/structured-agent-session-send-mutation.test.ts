import { describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from './agent-session-journal-types'
import type { AgentMessageSource } from './agent-session-message-source'
import { AgentJournalSubmissionSchema } from './agent-session-journal-submission-schema'
import { SendParams } from './rpc-contract/structured-agent-session-params'
import { structuredAgentSessionPayloadFingerprint } from './structured-agent-session-mutation'
import {
  agentSessionSendBodyFingerprint,
  structuredAgentSessionMessageSendMutation
} from './structured-agent-session-send-mutation'

const BODY: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'You have 1 orchestration message.' }]
}

const FROM: AgentMessageSource = {
  kind: 'agent',
  senders: [
    {
      party: { address: 'term_peer', terminalHandle: 'term_peer', orcaSessionId: null },
      name: 'Claude'
    }
  ],
  orchestration: { message: 'mail-notice', mailbox: 'run:r1', dispatchId: null, messages: [] }
}

describe('send fingerprints never cover the sender', () => {
  it('keeps message choices outside the operation and body fingerprints', () => {
    const send = (executionOptions?: { model: string; effort: string }) =>
      structuredAgentSessionMessageSendMutation({
        sessionId: 'session-1',
        clientOperationId: 'op-1',
        expectedRuntimeFence: 1,
        body: BODY,
        ...(executionOptions ? { executionOptions } : {})
      })
    const legacy = send()
    const chosen = send({ model: 'model-a', effort: 'high' })
    expect(chosen.envelope.payloadFingerprint).toBe(legacy.envelope.payloadFingerprint)
    expect(chosen.executionOptions).toEqual({ model: 'model-a', effort: 'high' })
    expect(SendParams.safeParse(legacy).success).toBe(true)
    expect(SendParams.safeParse(chosen).success).toBe(true)
    expect(SendParams.omit({ executionOptions: true }).safeParse(chosen).success).toBe(false)
  })

  it('lets an older submission reader drop the new optional choices', () => {
    const submission = {
      clientMessageId: 'message-1',
      executionOptions: { model: 'model-a' },
      fence: 1,
      payloadFingerprint: 'a'.repeat(64),
      dispatchState: 'accepted',
      providerItemId: null,
      reason: null,
      submittedAt: 1,
      resolvedAt: 2
    }
    expect(AgentJournalSubmissionSchema.parse(submission).executionOptions).toEqual({
      model: 'model-a'
    })
    expect(
      AgentJournalSubmissionSchema.omit({ executionOptions: true }).parse(submission)
    ).not.toHaveProperty('executionOptions')
  })

  it('keeps the digest every stored submission and draft already holds', () => {
    // Pinned bytes: a stored fingerprint that changed would stop matching its provider echo.
    expect(agentSessionSendBodyFingerprint('session-1', BODY)).toBe(
      'bf73e28368c0837ade16328692116535c6d97fc9924c70aa342a3cf18817d047'
    )
    expect(agentSessionSendBodyFingerprint('session-1', BODY)).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: 'session-1',
        fields: { body: BODY }
      })
    )
  })

  it('fingerprints a body with a sender exactly as the same body without one', () => {
    expect(agentSessionSendBodyFingerprint('session-1', { ...BODY, from: FROM })).toBe(
      agentSessionSendBodyFingerprint('session-1', BODY)
    )
    const send = (body: AgentJournalMessageItem) =>
      structuredAgentSessionMessageSendMutation({
        sessionId: 'session-1',
        clientOperationId: 'op-1',
        expectedRuntimeFence: 1,
        body,
        delivery: 'queue-if-active'
      })
    const withSender = send({ ...BODY, from: FROM })
    expect(withSender.envelope.payloadFingerprint).toBe(send(BODY).envelope.payloadFingerprint)
    // The sender still travels with the message itself.
    expect(withSender.body.from).toEqual(FROM)
  })

  it('refuses a client send whose body names a sender', () => {
    const params = (body: unknown) => ({
      envelope: {
        sessionId: 'session-1',
        clientOperationId: 'op-1',
        expectedRuntimeFence: 1,
        payloadFingerprint: 'a'.repeat(64)
      },
      body
    })
    expect(SendParams.safeParse(params(BODY)).success).toBe(true)
    expect(SendParams.safeParse(params({ ...BODY, from: FROM })).success).toBe(false)
  })
})
