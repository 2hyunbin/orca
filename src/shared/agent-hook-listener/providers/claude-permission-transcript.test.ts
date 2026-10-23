import { afterEach, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeHookPayload } from '../../agent-hook-listener'
import { cacheRelayLegacyAgentStatus } from '../../agent-status-legacy-relay-cache'
import { createHookListenerState } from '../listener-state'
import { pollClaudePermissionTranscript } from './claude-permission-transcript'
import { applyRelayHookEvent } from '../../../wsl-guest/agent-hook-event-admission'

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each([10, 100])(
  'isolates proposals from %i unrelated panes and commits only admitted updates',
  (count) => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const directory = mkdtempSync(join(tmpdir(), 'permission-proposal-'))
    directories.push(directory)
    const transcript = join(directory, 'session.jsonl')
    const fixture = readFileSync(
      join(__dirname, '../../__fixtures__/claude-permission-escape.jsonl'),
      'utf8'
    )
    writeFileSync(transcript, `${fixture.split('\n').slice(0, 3).join('\n')}\n`)
    const state = createHookListenerState()
    const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    const post = (payload: Record<string, unknown>) => {
      const event = normalizeHookPayload(
        state,
        'claude',
        {
          paneKey,
          tabId: 'tab-1',
          payload: {
            session_id: '00000000-0000-4000-8000-000000000000',
            transcript_path: transcript,
            ...payload
          }
        },
        'production'
      )
      if (!event) {
        throw new Error('missing event')
      }
      expect(cacheRelayLegacyAgentStatus(state, event, 256, () => {})).toBe(true)
      return event
    }
    post({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu_01QFGUSJNpFMqWgCSxXKSoRJ',
      tool_input: {
        command: 'printf permission_probe > escape2-probe.txt',
        description: 'Write probe text to a file'
      }
    })
    const original = post({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: {
        command: 'printf permission_probe > escape2-probe.txt',
        description: 'Write probe text to a file'
      }
    })
    let visited = 0
    class CountedMap<V> extends Map<string, V> {
      override *[Symbol.iterator](): MapIterator<[string, V]> {
        for (const entry of super[Symbol.iterator]()) {
          visited++
          yield entry
        }
      }
    }
    for (let i = 0; i < count; i++) {
      state.claudeLeadStateByPaneKey.set(`other-${i}`, { state: 'done', stateStartedAt: 1 })
      state.lastToolByPaneKey.set(`other-${i}`, {})
    }
    state.claudeLeadStateByPaneKey = new CountedMap(state.claudeLeadStateByPaneKey)
    state.lastToolByPaneKey = new CountedMap(state.lastToolByPaneKey)
    const lead = state.claudeLeadStateByPaneKey.get(paneKey)
    const tool = state.lastToolByPaneKey.get(paneKey)
    visited = 0
    const proposal = pollClaudePermissionTranscript(state, original)
    if (!proposal) {
      throw new Error('missing proposal')
    }
    expect(visited).toBe(0)
    const host = {
      state,
      metadata: new Map(),
      isCanonicalPane: () => true,
      isPaneSurfaceRetired: () => false,
      clearPaneState: () => {},
      clearAssistantMessageRetry: () => {},
      forward: () => {},
      checkAgentPresence: async () => {}
    }
    expect(
      applyRelayHookEvent(host, proposal.event, 'claude', 'production', undefined, {
        onAccepted: proposal.onAccepted
      })
    ).toBeUndefined()
    expect(state.claudeLeadStateByPaneKey.get(paneKey)).toBe(lead)
    expect(state.lastToolByPaneKey.get(paneKey)).toBe(tool)
    expect(pollClaudePermissionTranscript(state, original)?.event.payload).toEqual(
      proposal.event.payload
    )
    const admitted = applyRelayHookEvent(
      { ...host, isCanonicalPane: () => false },
      proposal.event,
      'claude',
      'production',
      undefined,
      { onAccepted: proposal.onAccepted }
    )
    expect(state.claudeLeadStateByPaneKey.get(paneKey)).toMatchObject({
      state: 'working'
    })
    expect(state.lastToolByPaneKey.get(paneKey)?.toolName).toBeUndefined()
    if (!admitted) {
      throw new Error('proposal not admitted')
    }
    appendFileSync(
      transcript,
      `${JSON.stringify({
        type: 'user',
        isSidechain: false,
        sessionId: original.providerSession?.id,
        uuid: 'new-prompt',
        parentUuid: 'escape2-node-3',
        message: { role: 'user', content: 'Continue working' }
      })}\n`
    )
    // Already working: retire the old observer without another status write or late verdict.
    expect(pollClaudePermissionTranscript(state, admitted)).toBeUndefined()
    expect(state.claudePermissionObservationByPaneKey.has(paneKey)).toBe(false)
    expect(state.claudeLeadStateByPaneKey.get('other-0')).toEqual({
      state: 'done',
      stateStartedAt: 1
    })
  }
)
