import type { AgentSessionConversationCommand } from '../../../src/shared/agent-session-conversation-command'
import type {
  AgentSessionOptionsResult,
  AgentSessionModelCatalogResult
} from '../../../src/shared/agent-session-wire'
import { callAgentSession } from './mobile-structured-agent-session-rpc'
import { forgetMobileCreatedStructuredSession } from './mobile-created-structured-sessions'
import { createCoalescingKeyedRunner } from '../../../src/shared/coalescing-keyed-runner'
import type { RpcClient } from '../transport/rpc-client'
import { independentAgentModelCatalog } from '../../../src/shared/agent-model-catalog-ownership'
import {
  createStructuredAgentSessionOptionProjection,
  observeStructuredAgentSessionInventory
} from '../../../src/shared/structured-agent-session-option-projection'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionOptionCatalog } from '../../../src/shared/agent-session-option-catalog'
import { cloneStructuredAgentSessionOptionRecord } from '../../../src/shared/structured-agent-session-option-state'
import {
  createStructuredAgentSessionOptionState,
  applyStructuredAgentSessionOptions,
  applyStructuredAgentSessionModelCatalog,
  settleStructuredAgentSessionBuiltinCatalog,
  type StructuredAgentSessionOptionState
} from '../../../src/shared/structured-agent-session-options'

export function useMobileStructuredOptionState(args: {
  client: RpcClient | null
  optionStamp?: string
  newLaunch: boolean
  worktree?: string
  agent: string | null
  enabled: boolean
  fence: number | null
  optionCatalog: AgentSessionOptionCatalog | null
  sessionId: string | null
}) {
  const {
    agent,
    enabled,
    fence,
    optionCatalog,
    sessionId,
    client,
    optionStamp,
    newLaunch,
    worktree
  } = args
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
  const projection = useMemo(
    () => createStructuredAgentSessionOptionProjection(),
    [agent, client, sessionId, newLaunch, worktree]
  )
  const contextRef = useRef({ projection, fence })
  contextRef.current = { projection, fence }
  const isCurrentContext = useCallback(
    () => contextRef.current.projection === projection && contextRef.current.fence === fence,
    [projection, fence]
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
    projection.writes = 0
    projection.pendingRead = false
    optionMutationGeneration.current += 1
    pendingOptionRef.current = null
    optionStateRef.current = next
    activeOptionRecordRef.current = next.record
    setOptionState(next)
  }, [agent, enabled, fence, optionCatalog, sessionId, projection])

  const [conversationSupport, setConversationSupport] = useState<{
    sessionId: string
    commands: readonly AgentSessionConversationCommand[]
    fence: number | null
  } | null>(null)
  const [imageSupport, setImageSupport] = useState<{
    sessionId: string
    acceptsImages: boolean | undefined
    /** The answer named the chat's permission mode, as only a host applying modes does. */
    statesPermissionMode: boolean
  } | null>(null)

  const awaitingOptions =
    conversationSupport?.sessionId === sessionId && conversationSupport.fence !== fence

  const readRef = useRef<(() => void) | null>(null)
  const capabilitiesPending = () =>
    independentAgentModelCatalog(agent ?? '') &&
    enabled &&
    (!projection.initial || projection.accepted !== projection.revision)
  const receiveCatalog = (
    catalog: AgentSessionModelCatalogResult | null,
    event: 'demand' | 'progress' | 'settled'
  ) => {
    const independent = independentAgentModelCatalog(agent ?? '')
    const changed = independent && observeStructuredAgentSessionInventory(projection, catalog)
    updateOptionState((current) =>
      catalog &&
      optionCatalog &&
      (!independent || changed || capabilitiesPending() || current.catalogSource !== 'live')
        ? applyStructuredAgentSessionModelCatalog(current, optionCatalog, catalog, {
            newLaunch,
            holdControls: capabilitiesPending() || awaitingOptions
          })
        : { ...settleStructuredAgentSessionBuiltinCatalog(current) }
    )
    if (
      changed ||
      (event !== 'progress' && independent && capabilitiesPending()) ||
      event === 'settled'
    ) {
      readRef.current?.()
    }
  }
  useEffect(() => {
    if (!client || !sessionId || !enabled || !optionCatalog) {
      return
    }
    let stale = false
    const run = createCoalescingKeyedRunner<void>()
    const request = () => {
      void run('options', 'latest', async () => {
        if (stale || !isCurrentContext()) {
          return
        }
        if (projection.writes) {
          projection.pendingRead = true
          return
        }
        projection.pendingRead = false
        const record = activeOptionRecordRef.current
        const revision = projection.revision
        const readGeneration = optionMutationGeneration.current
        const result = await callAgentSession<AgentSessionOptionsResult>(
          client,
          'agentSession.options',
          { sessionId }
        )
        if (
          stale ||
          !isCurrentContext() ||
          activeOptionRecordRef.current !== record ||
          projection.revision !== revision ||
          optionMutationGeneration.current !== readGeneration
        ) {
          return
        }
        projection.accepted = revision
        // This view keeps its latch; a later one may run a model picked here.
        forgetMobileCreatedStructuredSession(sessionId)
        setImageSupport({
          sessionId,
          acceptsImages: result.acceptsImages,
          statesPermissionMode: result.current?.permissionMode !== undefined
        })
        setConversationSupport({ sessionId, fence, commands: result.conversationCommands ?? [] })
        updateOptionState((current) =>
          applyStructuredAgentSessionOptions(current, optionCatalog, result, { newLaunch })
        )
      }).catch(() => undefined)
    }
    readRef.current = request
    request()
    return () => {
      stale = true
      readRef.current = null
    }
  }, [
    client,
    newLaunch,
    enabled,
    optionCatalog,
    optionStamp,
    isCurrentContext,
    projection,
    sessionId,
    fence,
    updateOptionState
  ])

  return {
    conversationSupport,
    imageSupport,
    awaitingOptions,
    projection,
    readRef,
    receiveCatalog,
    isCurrentContext,
    optionState,
    optionStateRef,
    activeOptionRecordRef,
    pendingOptionRef,
    optionMutationGeneration,
    updateOptionState
  }
}
