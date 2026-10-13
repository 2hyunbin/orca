import { toast } from 'sonner'
import { useCallback, useMemo } from 'react'
import type {
  AgentSessionOptionResult,
  AgentSessionOptionsResult
} from '../../../../shared/agent-session-wire'
import type { AgentType } from '../../../../shared/agent-status-types'
import { structuredAgentSessionSeedCatalog } from '../../../../shared/structured-agent-session-seed-catalog'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../../shared/agent-chat-permission-mode'
import {
  applyStructuredAgentSessionOptions,
  canSetStructuredAgentSessionOption,
  commitStructuredAgentSessionOptionValues,
  lockedStructuredAgentSessionOptionSnapshot,
  structuredAgentSessionOptionPicks,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { structuredAgentSessionHostKey } from '@/runtime/structured-agent-session-host-capability'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { enqueueSessionOptionSettingsWrite } from './native-chat-session-option-settings-write'
import { encodeStructuredAgentSessionOptionValue } from '../../../../shared/structured-agent-session-option-codec'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useHostModelCatalogUpgrade } from './use-host-model-catalog-upgrade'
import { useStructuredAgentSessionOptionState } from './use-structured-agent-session-option-state'
import { useStructuredAgentSessionOptionSurface } from './use-structured-agent-session-option-surface'
import { agentSessionWriteFailureText } from './agent-session-write-notice-text'
import type { StructuredAgentSessionLaunchView } from './use-native-chat-provisional-launch'
import {
  holdStructuredAgentSessionLaunchOption,
  type StructuredLaunchOptionOutcome
} from '@/lib/structured-agent-session-launch-options'

const NO_HELD_OPTIONS: Readonly<Record<string, string>> = {}

export function useStructuredAgentSessionOptions(args: {
  agent: AgentType
  sessionId: string
  target: RuntimeClientTarget
  transportEnabled: boolean
  isVisible: boolean
  providerVisible: boolean
  providerStarting?: boolean
  providerRunning?: boolean
  hostOptionStamp?: string
  optionSelection?: Readonly<Record<string, string>>
  fence: number | null
  turnId: string | null
  unloadedTurnRevisions: number | undefined
  mutate: StructuredAgentSessionMutate
  launch?: StructuredAgentSessionLaunchView
}) {
  const {
    agent,
    fence,
    launch,
    mutate,
    providerVisible,
    sessionId,
    target,
    transportEnabled,
    turnId
  } = args
  const launchSeedOptions = launch?.seedOptions
  const held = launch?.heldOptions ?? NO_HELD_OPTIONS
  // Published but not attached: the launch no longer holds picks and there is no fence to send one.
  const acceptsPicks = !transportEnabled || fence !== null
  const optionCatalog = useMemo(() => structuredAgentSessionSeedCatalog(agent), [agent])
  const identity = `${agent}:${sessionId}:${structuredAgentSessionHostKey(target)}`
  const selectionFromStatus = args.optionSelection !== undefined
  const {
    optionState,
    optionView,
    optionStateRef,
    activeOptionRecordRef,
    optionMutationGeneration,
    updateOptionState,
    rereadOptions,
    conversationSupport
  } = useStructuredAgentSessionOptionState({
    agent,
    optionCatalog,
    identity,
    fence,
    sessionId,
    target,
    newLaunch: launch?.kind === 'new',
    ...(launch?.worktree ? { worktree: launch.worktree } : {}),
    seedsModel: launchSeedOptions?.model !== undefined,
    providerVisible,
    providerStarting: args.providerStarting ?? false,
    hostOptionStamp: args.hostOptionStamp ?? '',
    // A new chat's host knows nothing of its model before the provider starts; a resumed one's
    // holds the model it ran, so only the former waits rather than show the host's guess.
    readsBeforeStart: launch?.kind !== 'new',
    hostSelection: args.optionSelection,
    launchSeedOptions,
    held,
    turnId,
    unloadedTurnRevisions: args.unloadedTurnRevisions
  })

  const hostCatalog = useHostModelCatalogUpgrade({
    agent,
    sessionId,
    target,
    optionCatalog,
    enabled: args.isVisible,
    // A resumed conversation may keep its own model, so only a new one runs the listed default.
    newLaunch: launch?.kind === 'new',
    ...(launch?.worktree ? { worktree: launch.worktree } : {}),
    fence,
    turnId,
    reportedUnpickedModel:
      launch?.kind === 'new' &&
      launchSeedOptions?.model === undefined &&
      optionState.catalogSource === 'live',
    ...(args.providerRunning ? { providerRunning: true } : {}),
    activeOptionRecordRef,
    updateOptionState,
    onListingLanded: rereadOptions
  })

  // What a settled pick must remember so the next launch starts where the user left off.
  const rememberOptionPicks = useCallback(
    (view: StructuredAgentSessionOptionState, committed: Readonly<Record<string, string>>) => {
      const picks = structuredAgentSessionOptionPicks(view, committed)
      if (picks.length > 0) {
        void enqueueSessionOptionSettingsWrite(target, { type: 'apply-picks', agent, picks })
      }
    },
    [agent, target]
  )
  const sendStructuredOption = useCallback(
    async (id: string, encoded: string): Promise<Readonly<Record<string, string>> | null> => {
      const targetRecord = optionStateRef.current.record
      const mutationGeneration = ++optionMutationGeneration.current
      const isCurrent = (): boolean =>
        activeOptionRecordRef.current === targetRecord &&
        optionMutationGeneration.current === mutationGeneration
      const shownAtOnce = id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID
      if (shownAtOnce && !selectionFromStatus) {
        updateOptionState((current) =>
          current.record === targetRecord
            ? commitStructuredAgentSessionOptionValues(current, { [id]: encoded })
            : current
        )
      }
      updateOptionState((current) => ({ ...current, pendingPick: { id, value: encoded } }))
      let result: AgentSessionOptionResult | null = null
      let committed: Readonly<Record<string, string>> | null = null
      try {
        result = await mutate<AgentSessionOptionResult>(
          'agentSession.setOption',
          'agentSession.setOption',
          { key: id, value: encoded }
        )
        if (result && isCurrent()) {
          const acceptedValues = result.options ?? { [id]: encoded }
          committed = acceptedValues
          updateOptionState((current) =>
            current.record === targetRecord && !selectionFromStatus
              ? commitStructuredAgentSessionOptionValues(current, acceptedValues)
              : current
          )
          rememberOptionPicks(optionView, acceptedValues)
          if (!selectionFromStatus) {
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
        }
        return committed
      } finally {
        if (shownAtOnce && !result && !selectionFromStatus && isCurrent()) {
          void callStructuredAgentSession<AgentSessionOptionsResult>(
            target,
            'agentSession.options',
            { sessionId }
          )
            .then((refreshed) => {
              if (isCurrent() && optionCatalog) {
                updateOptionState((latest) =>
                  applyStructuredAgentSessionOptions(latest, optionCatalog, refreshed)
                )
              }
            })
            .catch(() => {})
        }
        if (isCurrent()) {
          updateOptionState((current) =>
            current.record === targetRecord && current.pendingPick?.id === id
              ? { ...current, pendingPick: null }
              : current
          )
        }
      }
    },
    [
      activeOptionRecordRef,
      mutate,
      optionCatalog,
      optionMutationGeneration,
      optionStateRef,
      rememberOptionPicks,
      optionView,
      selectionFromStatus,
      sessionId,
      target,
      updateOptionState
    ]
  )
  const settleLaunchOptionPick = useCallback(
    (outcome: StructuredLaunchOptionOutcome) => {
      if (outcome.kind === 'refused') {
        toast.error(agentSessionWriteFailureText(outcome.failure, 'option'))
      } else if (outcome.kind === 'accepted') {
        rememberOptionPicks(optionView, outcome.options)
      }
    },
    [optionView, rememberOptionPicks]
  )
  const optionSnapshot = useMemo(() => {
    const snapshot = structuredAgentSessionOptionSnapshot(optionView)
    return acceptsPicks ? snapshot : lockedStructuredAgentSessionOptionSnapshot(snapshot)
  }, [acceptsPicks, optionView])
  const changeStructuredOption = useCallback(
    async (
      id: string,
      value: string | boolean
    ): Promise<Readonly<Record<string, string>> | null> => {
      const encoded = encodeStructuredAgentSessionOptionValue(id, value)
      if (
        !optionCatalog ||
        encoded === null ||
        !canSetStructuredAgentSessionOption(optionView, id, value)
      ) {
        return null
      }
      if (!transportEnabled || fence === null) {
        // No fence yet: the launch holds it and applies it before anything else is sent.
        const applied = holdStructuredAgentSessionLaunchOption(sessionId, id, encoded)
        void applied?.then(settleLaunchOptionPick)
        return applied === null ? null : { [id]: encoded }
      }
      return sendStructuredOption(id, encoded)
    },
    [
      fence,
      optionCatalog,
      optionView,
      optionStateRef,
      sendStructuredOption,
      sessionId,
      settleLaunchOptionPick,
      transportEnabled
    ]
  )
  const setStructuredOption = useCallback(
    async (id: string, value: string | boolean): Promise<boolean> =>
      (await changeStructuredOption(id, value)) !== null,
    [changeStructuredOption]
  )
  const optionSurface = useStructuredAgentSessionOptionSurface({
    sessionId,
    optionView,
    optionSnapshot,
    changeOption: changeStructuredOption
  })

  const support =
    transportEnabled && conversationSupport?.sessionId === sessionId ? conversationSupport : null
  return {
    conversationCommands: support?.commands ?? [],
    /** Absent unless this host and session can change the goal. */
    threadGoal: support?.threadGoal,
    /** Absent from a host that predates it or a session that writes no context facts. */
    contextUsage: support?.contextUsage,
    /** Absent from a host that predates it, and until the options read answers. */
    acceptsImages: support?.acceptsImages,
    /** Undefined until this fence's options read answers. */
    rewind: support?.fence === fence ? support.rewind : undefined,
    optionSnapshot,
    optionSurface,
    setStructuredOption,
    unavailable: hostCatalog.unavailable
  }
}
