import { useCallback } from 'react'
import type { AgentSessionOptionResult, AgentSessionOptionsResult } from '../../../../shared/agent-session-wire'
import type { AgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../../shared/agent-chat-permission-mode'
import { applyStructuredAgentSessionOptions, commitStructuredAgentSessionOptionValues, type StructuredAgentSessionOptionState } from '../../../../shared/structured-agent-session-options'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import type { useStructuredAgentSessionOptionState } from './use-structured-agent-session-option-state'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'

const NO_HELD_OPTIONS: Readonly<Record<string, string>> = {}

type OptionState = ReturnType<typeof useStructuredAgentSessionOptionState>
type OptionWrite = Pick<OptionState, 'activeOptionRecordRef' | 'optionMutationGeneration' | 'optionStateRef' | 'optionView' | 'pendingOptionRef' | 'updateOptionState'> & {
  launchSeedOptions: Readonly<Record<string, string>> | undefined
  mutate: StructuredAgentSessionMutate
  optionCatalog: AgentSessionOptionCatalog | null
  rememberOptionPicks: (view: StructuredAgentSessionOptionState, committed: Readonly<Record<string, string>>) => void
  sessionId: string
  target: RuntimeClientTarget
}

/** Applies a hosted pick and reconciles it only with the same session's live option record. */
export function useStructuredAgentSessionOptionWrite(args: OptionWrite) {
  const { activeOptionRecordRef, launchSeedOptions, mutate, optionCatalog, optionMutationGeneration, optionStateRef, optionView, pendingOptionRef, rememberOptionPicks, sessionId, target, updateOptionState } = args
  return useCallback(
    async (id: string, encoded: string): Promise<boolean> => {
      const currentState = optionStateRef.current
      const targetRecord = currentState.record
      const mutationGeneration = ++optionMutationGeneration.current
      const isCurrent = (): boolean =>
        activeOptionRecordRef.current === targetRecord &&
        optionMutationGeneration.current === mutationGeneration
      // Record-only: shown at once, so the picker stays usable while the write waits behind a start.
      const shownAtOnce = id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID
      if (shownAtOnce) {
        updateOptionState((current) =>
          current.record === targetRecord
            ? commitStructuredAgentSessionOptionValues(current, { [id]: encoded })
            : current
        )
      } else {
        pendingOptionRef.current = { id, value: encoded }
        updateOptionState((current) => ({ ...current, pendingId: id }))
      }
      let result: AgentSessionOptionResult | null = null
      try {
        result = await mutate<AgentSessionOptionResult>(
          'agentSession.setOption',
          'agentSession.setOption',
          { key: id, value: encoded }
        )
        if (result && isCurrent()) {
          const committed = result.options ?? { [id]: encoded }
          updateOptionState((current) =>
            current.record === targetRecord
              ? commitStructuredAgentSessionOptionValues(current, committed)
              : current
          )
          // The launch seed names the model an effort-only pick was made under.
          rememberOptionPicks(
            optionView(currentState, launchSeedOptions, NO_HELD_OPTIONS),
            committed
          )
        }
        return Boolean(result)
      } finally {
        // A settled write, or a shown one that failed, reads back what the host now holds.
        if (isCurrent() && (result || shownAtOnce)) {
          void callStructuredAgentSession<AgentSessionOptionsResult>(
            target,
            'agentSession.options',
            { sessionId }
          )
            .then((refreshed) => {
              if (isCurrent()) {
                updateOptionState((latest) =>
                  latest.record === targetRecord && optionCatalog
                    ? applyStructuredAgentSessionOptions(latest, optionCatalog, refreshed)
                    : latest
                )
              }
            })
            .catch(() => {})
        }
        if (isCurrent()) {
          pendingOptionRef.current = null
          updateOptionState((current) =>
            current.record === targetRecord && current.pendingId === id
              ? { ...current, pendingId: null }
              : current
          )
        }
      }
    },
    [
      activeOptionRecordRef,
      launchSeedOptions,
      mutate,
      optionCatalog,
      optionMutationGeneration,
      optionStateRef,
      optionView,
      pendingOptionRef,
      rememberOptionPicks,
      sessionId,
      target,
      updateOptionState
    ]
  )
}
