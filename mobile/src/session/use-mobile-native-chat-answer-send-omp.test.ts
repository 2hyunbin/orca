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
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
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

function waitingStatus(prompt: AskPrompt): AgentStatusEntry {
  return {
    agentType: 'omp',
    state: 'waiting',
    stateStartedAt: 10,
    turnStartedAt: 5,
    updatedAt: 10,
    prompt: '',
    paneKey: 'pane',
    stateHistory: [],
    toolName: 'ask',
    interactivePrompt: JSON.stringify(prompt)
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

  async function mount(
    client: RpcClient,
    agent: AgentType,
    options: {
      currentAsk?: AskPrompt | null
      currentAskStatus?: AgentStatusEntry | null
      onSendError?: (message: string) => void
    } = {}
  ): Promise<() => Promise<void>> {
    function Harness(): null {
      answerSend = useMobileNativeChatAnswerSend({
        client,
        enabled: true,
        handleRef: { current: 'terminal' },
        deviceTokenRef: { current: 'device' },
        agentRef: { current: agent },
        sessionId: 'session',
        streamIdentity: 'host\0worktree\0tab\0session',
        onSendError: options.onSendError ?? vi.fn(),
        currentAsk: options.currentAsk,
        currentAskStatus:
          options.currentAskStatus === undefined && options.currentAsk
            ? waitingStatus(options.currentAsk)
            : options.currentAskStatus
      })
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    return async () => {
      await act(async () => renderer?.update(createElement(Harness)))
    }
  }

  it('writes OMP groups from the shared key plan, paced, never as pasted labels', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    const prompt: AskPrompt = {
      questions: [
        { question: 'q1', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'q2', multiSelect: false, options: [{ label: 'C' }, { label: 'D' }] }
      ]
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture exercises only the scripted sendRequest port.
    await mount({ sendRequest } as unknown as RpcClient, 'omp', { currentAsk: prompt })
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

  it.each(['accepted', 'unknown'] as const)(
    'fences a later retry after an %s group even after the chain has unwound',
    async (outcome) => {
      const sendRequest = vi
        .fn()
        .mockResolvedValue(
          outcome === 'accepted' ? acceptedResponse() : { ...acceptedResponse(), result: {} }
        )
      const prompt: AskPrompt = {
        questions: [
          { question: 'Pick', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }
        ]
      }
      const onSendError = vi.fn()
      const options: {
        currentAsk: AskPrompt | null
        currentAskStatus?: AgentStatusEntry
        onSendError: typeof onSendError
      } = {
        currentAsk: prompt,
        onSendError
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the scripted sendRequest port is exercised.
      const rerender = await mount({ sendRequest } as unknown as RpcClient, 'omp', options)
      let first: Promise<boolean> | undefined
      await act(async () => {
        first = answerSend?.answerAsk(prompt, [{ indices: [1] }])
      })
      act(() => answerSend?.cancelPending())
      await expect(first).resolves.toBe(false)
      await expect(answerSend?.answerAsk(prompt, [{ indices: [1] }])).resolves.toBe(false)
      expect(sendRequest).toHaveBeenCalledTimes(1)
      expect(onSendError).toHaveBeenLastCalledWith(
        'Answer not sent — check terminal before retrying'
      )
      options.currentAsk = null
      await rerender()
      options.currentAsk = prompt
      await rerender()
      await expect(answerSend?.answerAsk(prompt, [{ indices: [1] }])).resolves.toBe(false)
      expect(sendRequest).toHaveBeenCalledTimes(1)
      options.currentAskStatus = { ...waitingStatus(prompt), stateStartedAt: 15, state: 'blocked' }
      await rerender()
      await expect(answerSend?.answerAsk(prompt, [{ indices: [1] }])).resolves.toBe(false)
      expect(sendRequest).toHaveBeenCalledTimes(1)
      options.currentAskStatus = { ...waitingStatus(prompt), turnStartedAt: 20, stateStartedAt: 25 }
      await rerender()
      sendRequest.mockResolvedValue(acceptedResponse())
      let next: Promise<boolean> | undefined
      await act(async () => {
        next = answerSend?.answerAsk(prompt, [{ indices: [1] }])
      })
      await act(async () => {
        await vi.runAllTimersAsync()
      })
      await expect(next).resolves.toBe(true)
    }
  )

  it('stops before the next group when the observed card is replaced', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    const prompt: AskPrompt = {
      questions: [
        { question: 'Pick', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }
      ]
    }
    const options = { currentAsk: prompt, onSendError: vi.fn() }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the scripted sendRequest port is exercised.
    const rerender = await mount({ sendRequest } as unknown as RpcClient, 'omp', options)
    let result: Promise<boolean> | undefined
    await act(async () => {
      result = answerSend?.answerAsk(prompt, [{ indices: [1] }])
    })
    options.currentAsk = { questions: [{ ...prompt.questions[0]!, question: 'Replacement' }] }
    await rerender()
    await act(async () => {
      await vi.runAllTimersAsync()
    })
    await expect(result).resolves.toBe(false)
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(options.onSendError).toHaveBeenCalledWith(
      'Answer partly sent — check chat before retrying'
    )
  })
  it.each(['missing status', 'working', 'different turn'] as const)(
    'stops writes when the prompt has %s',
    async (change) => {
      const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
      const prompt: AskPrompt = {
        questions: [
          { question: 'Pick', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }
        ]
      }
      const options: { currentAsk: AskPrompt; currentAskStatus: AgentStatusEntry | null } = {
        currentAsk: prompt,
        currentAskStatus: waitingStatus(prompt)
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the scripted sendRequest port is exercised.
      const rerender = await mount({ sendRequest } as unknown as RpcClient, 'omp', options)
      let result: Promise<boolean> | undefined
      await act(async () => {
        result = answerSend?.answerAsk(prompt, [{ indices: [1] }])
      })
      options.currentAskStatus =
        change === 'missing status'
          ? null
          : {
              ...waitingStatus(prompt),
              ...(change === 'working' ? { state: 'working' } : { turnStartedAt: 20 })
            }
      await rerender()
      await act(async () => {
        await vi.runAllTimersAsync()
      })
      await expect(result).resolves.toBe(false)
      expect(sendRequest).toHaveBeenCalledTimes(1)
    }
  )

  it('refuses a transcript-only OMP question before any terminal write', async () => {
    const sendRequest = vi.fn().mockResolvedValue(acceptedResponse())
    const prompt: AskPrompt = {
      questions: [
        { question: 'Pick', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }
      ]
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the scripted sendRequest port is exercised.
    await mount({ sendRequest } as unknown as RpcClient, 'omp', {
      currentAsk: prompt,
      currentAskStatus: null
    })
    await expect(answerSend?.answerAsk(prompt, [{ indices: [1] }])).resolves.toBe(false)
    expect(sendRequest).not.toHaveBeenCalled()
  })
})
