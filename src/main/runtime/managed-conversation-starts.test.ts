import { describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { terminalConversationKey } from '../native-chat/structured-conversation-key'
import { ManagedConversationStarts, type ManagedStartPty } from './managed-conversation-starts'
import { OrcaRuntimeService } from './orca-runtime'

const C = 'provider-session-alpha-1'
const key = terminalConversationKey('claude', C)

describe('managed conversation starts', () => {
  it('holds a start until its terminal reports the conversation or its execution ends', () => {
    const starts = new ManagedConversationStarts()
    const pty: ManagedStartPty = { incarnationId: null, cliConversations: undefined, exited: false }
    const read = vi.fn((): ManagedStartPty | null => pty)
    const reported = starts.reserve([key])
    expect(starts.live(key, read)).toBe(true)
    reported.bind('pty-1', null)
    expect(starts.live(key, read)).toBe(true)
    pty.cliConversations = {
      incarnationId: null,
      byKey: new Map([['k', { agent: 'claude', id: C, paneOwned: true }]])
    }
    expect(starts.live(key, read)).toBe(false)

    starts.reserve([terminalConversationKey('opencode2', null)]).bind('pty-2', null)
    // A targetless resume holds the whole family; a gone PTY ends it.
    expect(
      starts.live(terminalConversationKey('opencode', 'ses_1'), () => ({
        ...pty,
        cliConversations: undefined
      }))
    ).toBe(true)
    expect(starts.live(terminalConversationKey('opencode', 'ses_1'), () => null)).toBe(false)
  })

  it("refuses a chat's agent start while a start holds its conversation, never for its own hook row", async () => {
    const runtime = new OrcaRuntimeService()
    const record = agentSessionRecordFixture()
    const ownRow = {
      paneKey: 'chat',
      agentType: 'claude',
      structuredHost: 'owned',
      providerSession: { key: 'claude', id: C }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the census reads only these row fields.
    const rows = [ownRow as unknown as AgentStatusIpcPayload]
    vi.spyOn(runtime, 'getAgentProviderSessionRows').mockReturnValue(rows)
    const admit = () => runtime['assertStructuredChatAcquireAdmissible'](record)
    await expect(admit()).resolves.toBeUndefined()

    const start = runtime.reserveManagedConversationStart([key])
    await expect(admit()).rejects.toMatchObject({
      refusal: { details: { reason: 'conversationHeldElsewhere' } }
    })
    // Bound to a PTY this host doesn't run, the start can't write here.
    runtime.bindManagedConversationStart(start, 'pty-missing')
    await expect(admit()).resolves.toBeUndefined()
  })
})
