import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentSessionOptionCatalog } from '../../../src/shared/agent-session-option-catalog'
import { cloneStructuredAgentSessionOptionRecord } from '../../../src/shared/structured-agent-session-option-state'
import {
  createStructuredAgentSessionOptionState,
  type StructuredAgentSessionOptionState
} from '../../../src/shared/structured-agent-session-options'

export function useMobileStructuredOptionState(args: {
  agent: string | null
  enabled: boolean
  fence: number | null
  optionCatalog: AgentSessionOptionCatalog | null
  sessionId: string | null
}) {
  const { agent, enabled, fence, optionCatalog, sessionId } = args
  const [optionState, setOptionState] = useState(() =>
    createStructuredAgentSessionOptionState(agent ?? 'codex', optionCatalog)
  )
  const optionStateRef = useRef(optionState)
  const activeOptionRecordRef = useRef(optionState.record)
  const pendingOptionRef = useRef<string | null>(null)
  const optionMutationGeneration = useRef(0)
  const updateOptionState = useCallback(
    (update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState) => {
      const next = update(optionStateRef.current)
      optionStateRef.current = next
      setOptionState(next)
    },
    []
  )
  const optionIdentityRef = useRef(`${agent}:${sessionId}`)
  useEffect(() => {
    const identity = `${agent}:${sessionId}`
    const sameSession = optionIdentityRef.current === identity
    optionIdentityRef.current = identity
    const previous = optionStateRef.current
    const seeded = createStructuredAgentSessionOptionState(agent ?? 'codex', optionCatalog)
    // A host answer is the account's, not the fence's: keep it rather than fall back to the placeholder.
    const kept =
      sameSession && previous.catalogSource !== 'seed' && previous.catalogSource !== null
        ? {
            ...previous,
            catalogSource: 'host' as const,
            record: cloneStructuredAgentSessionOptionRecord(previous.record),
            pendingId: null
          }
        : seeded
    // The chat's own, which a restart for a new mode keeps: the pill never blanks between them.
    const next = sameSession ? { ...kept, permissionMode: previous.permissionMode } : kept
    optionMutationGeneration.current += 1
    pendingOptionRef.current = null
    optionStateRef.current = next
    activeOptionRecordRef.current = next.record
    setOptionState(next)
  }, [agent, enabled, fence, optionCatalog, sessionId])

  return {
    optionState,
    optionStateRef,
    activeOptionRecordRef,
    pendingOptionRef,
    optionMutationGeneration,
    updateOptionState
  }
}
