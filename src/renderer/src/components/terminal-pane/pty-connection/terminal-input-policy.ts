import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'
import { createAgentInterruptInference } from '../agent-interrupt-inference'
import { createAgentQuestionAnsweredInference } from '../agent-question-answered-inference'
import type { AgentInterruptInputIntent } from '../../../../../shared/agent-interrupt-intent'
import { isPassiveTerminalInputReport } from '../terminal-passive-input-report'
import { dismissRetainedProgramResult } from '@/lib/program-status/result-retention'
import { isRetainedProgramResult } from '@/lib/program-status/row'

export function createTerminalInputPolicy(services: {
  paneKey: string
  clearInferredInterruptWorkingTitle: () => void
  observeTitleOnlyInterrupt: () => void
  markBracketedPasteInterrupted: () => void
}) {
  const interruptInference = createAgentInterruptInference({
    paneKey: services.paneKey,
    getStatusEntry: () => useAppStore.getState().agentStatusByPaneKey[services.paneKey],
    inferInterrupt: (request) => {
      // Why: the explicit hook row is the authority for an in-flight agent turn.
      // Codex can reset its terminal title while handling Ctrl+C/Escape, so title
      // state must not veto clearing the row's working state.
      return window.api.agentStatus
        .inferInterrupt(request)
        .then((applied) => {
          if (applied) {
            services.clearInferredInterruptWorkingTitle()
          }
          return applied
        })
        .catch((err) => {
          console.warn('[agent-interrupt] inferInterrupt failed:', err)
          return false
        })
    }
  })
  const questionAnsweredInference = createAgentQuestionAnsweredInference({
    paneKey: services.paneKey,
    getStatusEntry: () => useAppStore.getState().agentStatusByPaneKey[services.paneKey],
    inferQuestionAnswered: (request) =>
      window.api.agentStatus.inferQuestionAnswered(request).catch((err) => {
        console.warn('[agent-question] inferQuestionAnswered failed:', err)
        return false
      })
  })
  const dropCommandFinishedStatusIfSameTurn = (
    entry: AgentStatusEntry | undefined,
    options?: { allowInferredInterrupt?: boolean }
  ): void => {
    const state = useAppStore.getState()
    if (!entry) {
      // Why: an Orca-started agent can exit before its first hook status. The
      // launch registry was still created up front, so clear it on command exit.
      state.clearAgentLaunchConfig(services.paneKey)
      return
    }
    const current = state.agentStatusByPaneKey[services.paneKey]
    if (!current) {
      state.clearAgentLaunchConfig(services.paneKey)
      return
    }
    const unchanged =
      current.state === entry.state &&
      current.prompt === entry.prompt &&
      current.updatedAt === entry.updatedAt &&
      current.stateStartedAt === entry.stateStartedAt &&
      current.agentType === entry.agentType
    const inferredFromEntry =
      options?.allowInferredInterrupt === true &&
      current.state === 'done' &&
      current.interrupted === true &&
      current.prompt === entry.prompt &&
      current.agentType === entry.agentType &&
      current.stateHistory?.some(
        (history) =>
          history.state === entry.state &&
          history.prompt === entry.prompt &&
          history.startedAt === entry.stateStartedAt
      ) === true
    if (!unchanged && !inferredFromEntry) {
      return
    }
    if (!isRetainedProgramResult(current)) {
      state.dropAgentStatus(services.paneKey)
    }
  }
  let pendingTerminalInputIntent: AgentInterruptInputIntent | null = null
  let clearPendingTerminalInputIntentTimer: ReturnType<typeof setTimeout> | null = null
  const clearPendingTerminalInputIntent = (): void => {
    pendingTerminalInputIntent = null
    if (clearPendingTerminalInputIntentTimer !== null) {
      clearTimeout(clearPendingTerminalInputIntentTimer)
      clearPendingTerminalInputIntentTimer = null
    }
  }
  const setPendingTerminalInputIntent = (intent: AgentInterruptInputIntent): void => {
    clearPendingTerminalInputIntent()
    pendingTerminalInputIntent = intent
    clearPendingTerminalInputIntentTimer = setTimeout(() => {
      clearPendingTerminalInputIntent()
    }, 0)
  }
  // Why: a focus or hover report landing between a keydown and its byte must not consume the intent.
  const pendingTerminalInputIntentFor = (data: string): AgentInterruptInputIntent | null =>
    isPassiveTerminalInputReport(data) ? null : pendingTerminalInputIntent
  const inputMatchesIntent = (intent: AgentInterruptInputIntent, data: string): boolean => {
    return (
      (intent === 'plain-escape' && data === '\x1b') || (intent === 'ctrl-c' && data === '\x03')
    )
  }
  const inferIntentFromExactTerminalInput = (data: string): AgentInterruptInputIntent | null => {
    if (data === '\x03') {
      return 'ctrl-c'
    }
    if (data === '\x1b') {
      return 'plain-escape'
    }
    return null
  }
  const observeSentTerminalInputIntent = (
    data: string,
    intent = pendingTerminalInputIntent
  ): void => {
    if (intent && inputMatchesIntent(intent, data)) {
      interruptInference.observeInputIntent(intent)
      services.observeTitleOnlyInterrupt()
    }
  }
  const observeAcceptedTerminalInput = (
    data: string,
    intent: AgentInterruptInputIntent | null = null
  ): void => {
    if (intent === 'ctrl-c' || data === '\x03') {
      services.markBracketedPasteInterrupted()
    }
    // Why: every delivered-input path funnels through here, so this is where a
    // submit keystroke into a waiting AskUserQuestion pane becomes the
    // "question answered" signal no hook will ever deliver.
    questionAnsweredInference.observeSentTerminalInput(data)
    if (!isPassiveTerminalInputReport(data)) {
      dismissRetainedProgramResult(services.paneKey, useAppStore.getState())
    }
  }
  let pendingTerminalInputWrite: Promise<boolean | null> | null = null
  // Why: an unset baseline must differ from the first `?? null` snapshot so the
  // first acknowledged input still advances the sequence.
  let sequencedInterruptStatusBaseline: AgentStatusEntry | null | undefined = undefined
  let interruptStatusBaselineSequence: number = 0
  const setPendingTerminalInputWrite = (promise: Promise<boolean | null>): void => {
    pendingTerminalInputWrite = promise
    void promise.finally(() => {
      if (pendingTerminalInputWrite === promise) {
        pendingTerminalInputWrite = null
      }
    })
  }
  const flushPendingInterruptInference = (): boolean | Promise<boolean> => {
    const pendingWrite = pendingTerminalInputWrite
    if (!pendingWrite) {
      return interruptInference.flushPending()
    }
    return pendingWrite.then((immediateResult) => {
      return immediateResult ?? interruptInference.flushPending()
    })
  }
  return {
    interruptInference,
    questionAnsweredInference,
    dropCommandFinishedStatusIfSameTurn,
    get pendingTerminalInputIntent() {
      return pendingTerminalInputIntent
    },
    set pendingTerminalInputIntent(value: AgentInterruptInputIntent | null) {
      pendingTerminalInputIntent = value
    },
    get clearPendingTerminalInputIntentTimer() {
      return clearPendingTerminalInputIntentTimer
    },
    set clearPendingTerminalInputIntentTimer(value: ReturnType<typeof setTimeout> | null) {
      clearPendingTerminalInputIntentTimer = value
    },
    clearPendingTerminalInputIntent,
    setPendingTerminalInputIntent,
    pendingTerminalInputIntentFor,
    inputMatchesIntent,
    inferIntentFromExactTerminalInput,
    observeSentTerminalInputIntent,
    observeAcceptedTerminalInput,
    get pendingTerminalInputWrite() {
      return pendingTerminalInputWrite
    },
    set pendingTerminalInputWrite(value: Promise<boolean | null> | null) {
      pendingTerminalInputWrite = value
    },
    get sequencedInterruptStatusBaseline() {
      return sequencedInterruptStatusBaseline
    },
    set sequencedInterruptStatusBaseline(value: AgentStatusEntry | null | undefined) {
      sequencedInterruptStatusBaseline = value
    },
    get interruptStatusBaselineSequence() {
      return interruptStatusBaselineSequence
    },
    set interruptStatusBaselineSequence(value: number) {
      interruptStatusBaselineSequence = value
    },
    setPendingTerminalInputWrite,
    flushPendingInterruptInference
  }
}
