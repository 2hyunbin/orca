// Takeover RPCs have their own send-site integration tests; these fixtures script PTY acknowledgements.
vi.mock('../terminal/worker-terminal-takeover-report', () => ({
  reportWorkerTerminalUserInput: vi.fn()
}))

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatAskAnswer,
  type AskAnswerSelection,
  type AskPrompt
} from '../../../src/shared/native-chat-ask'
import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../../src/shared/agent-tui-input-clear'
import type { AgentType } from '../../../src/shared/native-chat-types'
import type { RpcClient } from '../transport/rpc-client'
import { MOBILE_NATIVE_CHAT_QUESTION_STEP_MS } from './mobile-native-chat-answer-stepping'
import { resetMobileNativeChatStaleInputForTests } from './mobile-native-chat-stale-input'
import { resetMobileNativeChatTerminalWritesForTests } from './mobile-native-chat-terminal-write-lock'
import {
  useMobileNativeChatAnswerSend,
  type MobileNativeChatAnswerSend
} from './use-mobile-native-chat-answer-send'

function acceptedResponse() {
  return {
    id: 'send',
    ok: true as const,
    result: { send: { accepted: true } },
    _meta: { runtimeId: 'runtime' }
  }
}

describe('useMobileNativeChatAnswerSend for OMP asks', () => {
  let renderer: ReactTestRenderer | null = null
  let answerSend: MobileNativeChatAnswerSend | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    resetMobileNativeChatStaleInputForTests()
    resetMobileNativeChatTerminalWritesForTests()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    answerSend = null
    vi.useRealTimers()
  })

  async function mount(client: RpcClient, agent: AgentType): Promise<void> {
    function Harness(): null {
      answerSend = useMobileNativeChatAnswerSend({
        client,
        enabled: true,
        handleRef: { current: 'terminal' },
        deviceTokenRef: { current: 'device' },
        agentRef: { current: agent },
        sessionId: 'session',
        streamIdentity: 'host\0worktree\0tab\0session',
        onSendError: vi.fn()
      })
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
  }

  it('writes OMP groups from the shared key plan, paced, never as pasted labels', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture exercises only the scripted sendRequest port.
    await mount({ sendRequest } as unknown as RpcClient, 'omp')
    const prompt: AskPrompt = {
      questions: [
        { question: 'q1', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'q2', multiSelect: false, options: [{ label: 'C' }, { label: 'D' }] }
      ]
    }
    const selections: AskAnswerSelection[] = [{ indices: [1] }, { indices: [0] }]
    const expected = [
      AGENT_TUI_CLEAR_INPUT_MAX,
      '\x1b[A\x1b[A\x1b[B',
      '\r',
      '\x1b[A\x1b[A',
      '\r',
      '\r'
    ]

    let result: Promise<boolean> | undefined
    await act(async () => {
      result = answerSend?.answerAsk(prompt, selections)
    })
    expect(sendRequest).toHaveBeenCalledTimes(1)
    for (let index = 1; index < expected.length; index += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MOBILE_NATIVE_CHAT_QUESTION_STEP_MS)
      })
      expect(sendRequest).toHaveBeenCalledTimes(index + 1)
    }
    await expect(result).resolves.toBe(true)
    expect(sendRequest.mock.calls.map((call) => call[1])).toEqual(
      expected.map((text) => expect.objectContaining({ text, enter: false }))
    )
    expect(sendRequest.mock.calls.map((call) => call[1])).not.toContainEqual(
      expect.objectContaining({ text: formatAskAnswer(prompt, selections), enter: true })
    )
  })
})
