import { toast } from 'sonner'
import { useCallback, useMemo } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { structuredAgentSessionSeedCatalog } from '../../../../shared/structured-agent-session-seed-catalog'
import type { SessionOptionsSurface } from '../../../../shared/native-chat-session-options'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../../shared/agent-chat-permission-mode'
import {
  canSetStructuredAgentSessionOption,
  lockedStructuredAgentSessionOptionSnapshot,
  structuredAgentSessionOptionSnapshot,
  structuredAgentSessionOptionPicks,
  structuredAgentSessionModelOffers
} from '../../../../shared/structured-agent-session-options'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { encodeStructuredAgentSessionOptionValue } from '../../../../shared/structured-agent-session-option-codec'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useHostModelCatalogUpgrade } from './use-host-model-catalog-upgrade'
import { useStructuredAgentSessionOptionState } from './use-structured-agent-session-option-state'
import { agentSessionWriteFailureText } from './agent-session-write-notice-text'
import type { StructuredAgentSessionLaunchView } from './use-native-chat-provisional-launch'
import {
  getStructuredAgentSessionLaunchSelection,
  setStructuredSessionSelectionOption,
  holdStructuredAgentSessionLaunchOption
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
  fence: number | null
  turnId: string | null
  unloadedTurnRevisions: number | undefined
  mutate: StructuredAgentSessionMutate
  launch?: StructuredAgentSessionLaunchView
}) {
  const { agent, fence, launch, providerVisible, sessionId, target, transportEnabled, turnId } =
    args
  const providerStarting = args.providerStarting ?? false
  const newLaunch = launch?.kind === 'new'
  const launchSeedOptions = launch?.seedOptions
  const held = launch?.heldOptions ?? NO_HELD_OPTIONS
  // Published but not attached: the launch no longer holds picks and there is no fence to send one.
  const acceptsPicks = (!transportEnabled || fence !== null) && launch?.seedPending !== true
  const optionCatalog = useMemo(() => structuredAgentSessionSeedCatalog(agent), [agent])
  const {
    optionView,
    takesSendOptions,
    optionState,
    optionStateRef,
    activeOptionRecordRef,
    controller,
    takesSelection,
    updateOptionState,
    rereadOptions,
    conversationSupport
  } = useStructuredAgentSessionOptionState({
    agent,
    optionCatalog,
    identity: `${agent}:${sessionId}`,
    fence,
    sessionId,
    target,
    newLaunch,
    ...(launch?.worktree ? { worktree: launch.worktree } : {}),
    seedsModel: launchSeedOptions?.model !== undefined,
    providerVisible,
    providerStarting,
    hostOptionStamp: args.hostOptionStamp ?? '',
    // A new chat's host knows nothing of its model before the provider starts; a resumed one's
    // holds the model it ran, so only the former waits rather than show the host's guess.
    readsBeforeStart: launch?.kind !== 'new',
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
    newLaunch,
    ...(launch?.worktree ? { worktree: launch.worktree } : {}),
    fence,
    turnId,
    reportedUnpickedModel:
      newLaunch && launchSeedOptions?.model === undefined && optionState.catalogSource === 'live',
    ...(args.providerRunning ? { providerRunning: true } : {}),
    activeOptionRecordRef,
    updateOptionState,
    onListingLanded: rereadOptions
  })

  const snapshot = structuredAgentSessionOptionSnapshot(
    optionView(optionState, launchSeedOptions, held)
  )
  const optionSnapshot = acceptsPicks
    ? snapshot
    : lockedStructuredAgentSessionOptionSnapshot(snapshot)
  const setStructuredOption = useCallback(
    async (id: string, value: string | boolean): Promise<boolean> => {
      const view = optionView(optionStateRef.current, launchSeedOptions, held)
      const pickState = {
        ...view,
        pendingId:
          providerStarting || !controller.pending().some((operation) => operation.key === id)
            ? null
            : id
      }
      const encoded = encodeStructuredAgentSessionOptionValue(id, value)
      if (
        !optionCatalog ||
        encoded === null ||
        !canSetStructuredAgentSessionOption(pickState, id, value)
      ) {
        return false
      }
      if (!transportEnabled || fence === null) {
        const applied = holdStructuredAgentSessionLaunchOption(sessionId, id, encoded, view)
        void applied?.then((outcome) => {
          if (outcome.kind === 'refused' && outcome.failure) {
            toast.error(agentSessionWriteFailureText(outcome.failure, 'option'))
          }
          rereadOptions()
        })
        return applied !== null
      }
      const context = structuredAgentSessionOptionPicks(view, { [id]: encoded })[0]?.modelId ?? null
      const operation = controller.issue(id, encoded, context, (key, candidate) =>
        structuredAgentSessionModelOffers(view, encoded, key, candidate)
      )
      updateOptionState((current) => ({
        ...current,
        pendingId: providerStarting || id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID ? null : id
      }))
      void controller.flush((pick) =>
        setStructuredSessionSelectionOption(target, sessionId, fence, pick.key, pick.value)
      )
      const outcome = await operation.result
      updateOptionState((current) => ({
        ...current,
        pendingId: controller.pending().at(-1)?.key ?? null
      }))
      if (outcome.kind === 'refused' && outcome.failure) {
        toast.error(agentSessionWriteFailureText(outcome.failure, 'option'))
      }
      rereadOptions()
      return outcome.kind !== 'refused'
    },
    [
      controller,
      fence,
      held,
      launchSeedOptions,
      target,
      optionCatalog,
      optionStateRef,
      optionView,
      providerStarting,
      rereadOptions,
      sessionId,
      transportEnabled,
      updateOptionState
    ]
  )
  const setOption = useCallback(
    async (id: string, value: string | boolean) => {
      await setStructuredOption(id, value)
      // Read, not rendered: a pick the launch just took is not in this render's props yet.
      const currentHeld = getStructuredAgentSessionLaunchSelection(sessionId)?.held
      return {
        snapshot: structuredAgentSessionOptionSnapshot(
          optionView(optionStateRef.current, launchSeedOptions, currentHeld ?? NO_HELD_OPTIONS)
        )
      }
    },
    [launchSeedOptions, optionStateRef, optionView, sessionId, setStructuredOption]
  )
  const optionSurface = useMemo<SessionOptionsSurface>(
    () => ({
      getSnapshot: () => optionSnapshot,
      setOption,
      invokeAction: async () => ({ snapshot: optionSnapshot }),
      subscribe: () => () => {}
    }),
    [setOption, optionSnapshot]
  )

  const support =
    transportEnabled && conversationSupport?.sessionId === sessionId ? conversationSupport : null
  return {
    conversationCommands: support?.commands ?? [],
    /** Absent unless this host and session can change the goal. */
    threadGoal: support?.threadGoal,
    /** A goal only the agent's own `/goal` changes; absent from a host that predates it. */
    reportedThreadGoal: support?.reportedThreadGoal,
    /** Absent from a host that predates it or a session that writes no context facts. */
    contextUsage: support?.contextUsage,
    /** Absent from a host that predates it, and until the options read answers. */
    acceptsImages: support?.acceptsImages,
    /** Undefined until this fence's options read answers. */
    rewind: support?.fence === fence ? support.rewind : undefined,
    optionSnapshot,
    optionSurface,
    setStructuredOption,
    sendSource: { optionStateRef, optionView, takesSendOptions, takesSelection },
    unavailable: hostCatalog.unavailable
  }
}
