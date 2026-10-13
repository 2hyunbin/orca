import { describe, expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionProviderHandle } from '../../shared/agent-session-provider-handle'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../shared/agent-session-provider-handle-encoding'
import { nativeChatOwnsTerminalResume } from './structured-session-ownership'

const CLAUDE_ID = 'b6bd7d57-2ec3-4e62-a47d-715e2455301d'
const CODEX_ID = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'
const PI_ID = '019fd622-3c4d-7e5f-a061-7c8d9e0f1a2b'
const PI_FILE = `/Users/me/.pi/agent/sessions/--Users-me-repo--/2026-10-09T10-00-00-000Z_${PI_ID}.jsonl`

function chatRecord(
  provider: AgentSessionRecord['provider'],
  handles: AgentSessionProviderHandle[],
  workspaceId = 'structured-chat-default'
): AgentSessionRecord {
  const record = agentSessionRecordFixture()
  return {
    ...record,
    provider,
    location: { ...record.location, workspaceId },
    providerHandleChain: handles.map((handle, index) => ({
      ...record.providerHandleChain[0]!,
      linkId: `link-${index}`,
      handle
    }))
  }
}

describe('nativeChatOwnsTerminalResume', () => {
  it('owns a conversation a chat in any workspace started, whatever pane saved it', () => {
    const records = [chatRecord('claude', [claudeProviderHandle(CLAUDE_ID, null)])]

    expect(
      nativeChatOwnsTerminalResume(records, 'claude', { key: 'session_id', id: CLAUDE_ID })
    ).toBe(true)
    expect(
      nativeChatOwnsTerminalResume(records, 'claude', {
        key: 'session_id',
        id: CLAUDE_ID.toUpperCase()
      })
    ).toBe(true)
  })

  it('owns every conversation in the chat chain, not only its current one', () => {
    const records = [
      chatRecord('codex', [codexProviderHandle(CODEX_ID), codexProviderHandle('019fd7aa-0000')])
    ]

    expect(
      nativeChatOwnsTerminalResume(records, 'codex', { key: 'session_id', id: CODEX_ID })
    ).toBe(true)
  })

  it('matches a session-file agent by the file its hook reported', () => {
    const records = [chatRecord('pi', [{ transport: 'jsonl-rpc', agent: 'pi', nativeId: PI_FILE }])]

    expect(
      nativeChatOwnsTerminalResume(records, 'pi', {
        key: 'session_id',
        id: 'pi-hook-id',
        transcriptPath: PI_FILE
      })
    ).toBe(true)
  })

  it('leaves a terminal its own conversation and other agents alone', () => {
    const records = [chatRecord('claude', [claudeProviderHandle(CLAUDE_ID, null)])]

    expect(
      nativeChatOwnsTerminalResume(records, 'claude', {
        key: 'session_id',
        id: '2f0c1d3e-0000-4000-8000-000000000001'
      })
    ).toBe(false)
    expect(
      nativeChatOwnsTerminalResume(records, 'codex', { key: 'session_id', id: CLAUDE_ID })
    ).toBe(false)
    expect(
      nativeChatOwnsTerminalResume(records, 'gemini', { key: 'session_id', id: CLAUDE_ID })
    ).toBe(false)
    expect(nativeChatOwnsTerminalResume([], 'claude', { key: 'session_id', id: CLAUDE_ID })).toBe(
      false
    )
  })
})
