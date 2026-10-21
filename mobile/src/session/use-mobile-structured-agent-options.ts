import { useMobileStructuredSelectionController } from './use-mobile-structured-selection-controller'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionConversationCommand } from '../../../src/shared/agent-session-conversation-command'
import { isAgentSessionHandleProvider } from '../../../src/shared/agent-session-provider-handle'
import { structuredAgentSessionSeedCatalog } from '../../../src/shared/structured-agent-session-seed-catalog'
import type {
  AgentSessionOptionResult,
  AgentSessionOptionsResult
} from '../../../src/shared/agent-session-wire'
import type { SessionOptionValue } from '../../../src/shared/native-chat-session-options'
import {
  applyStructuredAgentSessionOptions,
  canSetStructuredAgentSessionOption,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionPicks,
  structuredAgentSessionModelOffers,
  type StructuredAgentSessionOptionState
} from '../../../src/shared/structured-agent-session-options'
import {
  structuredAgentSessionOptionView,
  structuredAgentSessionSendSelection,
  structuredAgentSessionMessageSelection,
  structuredAgentSessionShownSnapshot
} from '../../../src/shared/structured-agent-session-option-view'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  agentChatPermissionModes
} from '../../../src/shared/agent-chat-permission-mode'
import { legacyHostPermissionDescriptor } from '../../../src/shared/structured-agent-session-permission-option'
import type { RpcClient } from '../transport/rpc-client'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import {
  callAgentSession,
  type StructuredAgentSessionMutate
} from './mobile-structured-agent-session-rpc'
import { useMobileHostModelCatalogUpgrade } from './use-mobile-host-model-catalog-upgrade'
import {
  forgetMobileCreatedStructuredSession,
  mobileCreatedStructuredSession
} from './mobile-created-structured-sessions'
import { encodeStructuredAgentSessionOptionValue } from '../../../src/shared/structured-agent-session-option-codec'
import { useMobileStructuredOptionSurface } from './use-mobile-structured-option-surface'

const NO_COMMANDS: readonly AgentSessionConversationCommand[] = []

export function useMobileStructuredAgentOptions(args: {
  agent: string | null
  client: RpcClient | null
  sessionId: string | null
  enabled: boolean
  fence: number | null
  turnId?: string | null
  mutate: StructuredAgentSessionMutate
  /** Moves when the host's status says a session option changed; each move re-reads them. */
  optionStamp?: string
  /** What the host advertised; null until its status probe answers. */
  hostSupport:
    | (Pick<StructuredAgentSessionHostSupport, 'permissionModes'> &
        Partial<Pick<StructuredAgentSessionHostSupport, 'sendSelection' | 'sendOptions'>>)
    | null
}) {
  const { agent, client, enabled, fence, mutate, optionStamp, sessionId, hostSupport, turnId } =
    args
  // Every agent's seed, as on the desktop: a built-in list or the provider-default pill.
  const optionCatalog = useMemo(
    () => (agent ? structuredAgentSessionSeedCatalog(agent) : null),
    [agent]
  )
  const [optionState, setOptionState] = useState(() =>
    createStructuredAgentSessionOptionState(agent ?? 'codex', optionCatalog)
  )
  const optionStateRef = useRef(optionState)
  const activeOptionRecordRef = useRef(optionState.record)
  const pendingOptionRef = useRef<string | null>(null)
  const readEpoch = useRef(0)
  const [rereads, setRereads] = useState(0)
  const reread = useCallback(() => {
    readEpoch.current += 1
    setRereads((count) => count + 1)
  }, [])
  const { controller, clientGeneration } = useMobileStructuredSelectionController({
    agent,
    client,
    sessionId,
    onRevalidate: reread
  })
  const updateOptionState = useCallback(
    (update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState) => {
      const next = update(optionStateRef.current)
      optionStateRef.current = next
      setOptionState(next)
    },
    []
  )
  const [conversationSupport, setConversationSupport] = useState<{
    sessionId: string
    commands: readonly AgentSessionConversationCommand[]
  } | null>(null)
  const [imageSupport, setImageSupport] = useState<{
    sessionId: string
    acceptsImages: boolean | undefined
    /** The answer named the chat's permission mode, as only a host applying modes does. */
    statesPermissionMode: boolean
  } | null>(null)

  const optionIdentityRef = useRef({ agent, sessionId, client, clientGeneration })
  useEffect(() => {
    const previousIdentity = optionIdentityRef.current
    const sameSession =
      previousIdentity.agent === agent &&
      previousIdentity.sessionId === sessionId &&
      previousIdentity.client === client &&
      previousIdentity.clientGeneration === clientGeneration
    optionIdentityRef.current = { agent, sessionId, client, clientGeneration }
    const previous = optionStateRef.current
    const seeded = createStructuredAgentSessionOptionState(agent ?? 'codex', optionCatalog)
    // A host answer is the account's, not the fence's: keep it rather than fall back to the placeholder.
    const kept =
      sameSession && (previous.catalogSource === 'host' || previous.catalogSource === 'builtin')
        ? { ...seeded, catalog: previous.catalog, catalogSource: previous.catalogSource }
        : seeded
    // The chat's own, which a restart for a new mode keeps: the pill never blanks between them.
    const next = sameSession ? { ...kept, permissionMode: previous.permissionMode } : kept
    pendingOptionRef.current = null
    optionStateRef.current = next
    activeOptionRecordRef.current = next.record
    setOptionState(next)
  }, [agent, client, clientGeneration, enabled, fence, optionCatalog, sessionId])

  // A chat this phone created runs the listed default, as a desktop chat its own view launched does.
  const createdHere = useMemo(
    () => (sessionId ? mobileCreatedStructuredSession(sessionId) : undefined),
    [sessionId]
  )
  // An options answer made before the account's listing landed listed none of it.
  const [listingsLanded, setListingsLanded] = useState(0)
  const onListingLanded = useCallback(() => setListingsLanded((count) => count + 1), [])
  useMobileHostModelCatalogUpgrade({
    agent,
    client,
    sessionId,
    enabled,
    fence,
    newLaunch: createdHere !== undefined,
    ...(createdHere ? { worktree: createdHere.worktree } : {}),
    optionCatalog,
    activeOptionRecordRef,
    updateOptionState,
    onListingLanded
  })

  useEffect(() => {
    if (!client || !sessionId || !enabled || !optionCatalog) {
      return
    }
    let stale = false
    const epoch = ++readEpoch.current
    const completed = controller.captureRead()
    const generation = client.getGeneration?.()
    void callAgentSession<AgentSessionOptionsResult>(
      client,
      'agentSession.options',
      { sessionId },
      undefined,
      { coalesce: sessionId }
    )
      .then((result) => {
        // This view keeps its latch; a later one may run a model picked here.
        forgetMobileCreatedStructuredSession(sessionId)
        // Not an option value: a pick made during the read leaves it standing.
        if (!stale) {
          setImageSupport({
            sessionId,
            acceptsImages: result.acceptsImages,
            statesPermissionMode: result.current?.permissionMode !== undefined
          })
        }
        if (!stale && readEpoch.current === epoch && generation === client.getGeneration?.()) {
          setConversationSupport({ sessionId, commands: result.conversationCommands ?? [] })
          updateOptionState((current) =>
            current.record === activeOptionRecordRef.current
              ? applyStructuredAgentSessionOptions(current, optionCatalog, result, {
                  newLaunch: createdHere !== undefined
                })
              : current
          )
          controller.retire(completed)
        }
      })
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [
    client,
    controller,
    createdHere,
    enabled,
    optionCatalog,
    optionStamp,
    turnId,
    listingsLanded,
    rereads,
    sessionId,
    fence,
    updateOptionState
  ])

  // A host predating per-chat modes (1.4.224 and older) states none: say what its chats run instead.
  const legacyHostPermissions =
    agent !== null &&
    agentChatPermissionModes(agent) !== null &&
    hostSupport?.permissionModes === false &&
    imageSupport?.sessionId === sessionId &&
    !imageSupport.statesPermissionMode &&
    optionState.permissionMode === null
  const shown = structuredAgentSessionShownSnapshot(
    structuredAgentSessionOptionView(optionState, undefined, controller.overlay())
  )
  const optionSnapshot = legacyHostPermissions
    ? [...shown, legacyHostPermissionDescriptor()]
    : shown

  const setStructuredOption = useCallback(
    async (id: string, value: SessionOptionValue): Promise<boolean> => {
      const currentState = optionStateRef.current
      const encoded = encodeStructuredAgentSessionOptionValue(id, value)
      if (
        pendingOptionRef.current !== null ||
        !client ||
        !sessionId ||
        !optionCatalog ||
        encoded === null ||
        !canSetStructuredAgentSessionOption(
          structuredAgentSessionOptionView(currentState, undefined, controller.overlay()),
          id,
          value
        )
      ) {
        return false
      }
      const targetRecord = currentState.record
      const view = structuredAgentSessionOptionView(currentState, undefined, controller.overlay())
      const model = structuredAgentSessionOptionPicks(view, { [id]: encoded })[0]?.modelId ?? null
      const operation = controller.issue(id, encoded, model, (key, candidate) =>
        structuredAgentSessionModelOffers(view, encoded, key, candidate)
      )
      if (id !== AGENT_CHAT_PERMISSION_MODE_OPTION_ID) {
        pendingOptionRef.current = id
        updateOptionState((current) => ({ ...current, pendingId: id }))
      }
      void controller.flush(async (pick) => {
        // A queued pick never retargets a replacement runtime.
        if (activeOptionRecordRef.current !== targetRecord) {
          return { kind: 'superseded' }
        }
        const result = await mutate<AgentSessionOptionResult>(
          'agentSession.setOption',
          'agentSession.setOption',
          { key: pick.key, value: pick.value }
        )
        return result.status === 'accepted'
          ? { kind: 'accepted', options: result.value.options ?? { [pick.key]: pick.value } }
          : result.status === 'unknown'
            ? { kind: 'unknown' }
            : { kind: 'refused' }
      })
      const outcome = await operation.result
      if (activeOptionRecordRef.current === targetRecord) {
        pendingOptionRef.current = null
        updateOptionState((current) => ({ ...current, pendingId: null }))
        if (outcome.kind === 'refused') {
          reread()
        }
      }
      return outcome.kind !== 'refused'
    },
    [client, controller, mutate, optionCatalog, reread, sessionId, updateOptionState]
  )

  // Controls and capture derive from the same queried base and transient operations.
  const sendSelection = useCallback(() => {
    const view = structuredAgentSessionOptionView(
      optionStateRef.current,
      undefined,
      controller.overlay()
    )
    return hostSupport?.sendSelection
      ? { selection: structuredAgentSessionMessageSelection(view) }
      : hostSupport?.sendOptions
        ? { options: structuredAgentSessionSendSelection(view) }
        : {}
  }, [controller, hostSupport?.sendSelection, hostSupport?.sendOptions])

  const readOptionState = useCallback(
    () => structuredAgentSessionOptionView(optionStateRef.current, undefined, controller.overlay()),
    [controller]
  )
  const { optionPickerRequest, invokeStructuredOption, optionSurface } =
    useMobileStructuredOptionSurface({
      optionSnapshot,
      setStructuredOption,
      readOptionState
    })

  return {
    optionPickerRequest,
    conversationCommands:
      conversationSupport?.sessionId === sessionId ? conversationSupport.commands : NO_COMMANDS,
    /** The chat takes images, as its options report says; else only Claude and Codex, as before. */
    acceptsImages:
      (imageSupport?.sessionId === sessionId ? imageSupport.acceptsImages : undefined) ??
      (agent !== null && isAgentSessionHandleProvider(agent)),
    optionSnapshot,
    optionSurface,
    pendingOptionId: optionState.pendingId,
    setStructuredOption,
    invokeStructuredOption,
    sendSelection
  }
}
