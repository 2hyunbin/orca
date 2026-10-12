import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionConversationCommand } from '../../../../shared/agent-session-conversation-command'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session-wire'
import type { AgentSessionRewindSupport } from '../../../../shared/agent-session-rewind'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { AgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import { structuredAgentSessionSeedCatalog } from '../../../../shared/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionCatalog,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { readHostModelCatalogSnapshot } from '@/runtime/host-model-catalog-snapshots'
import {
  cloneNativeChatSessionOptionRecord,
  createNativeChatSessionOptionRecord
} from '../../../../shared/native-chat-session-option-state'
import { structuredAgentSessionOptionView } from '../../../../shared/structured-agent-session-option-view'
import {
  createCoalescedPollRunner,
  type CoalescedPollRunner
} from '../right-sidebar/coalesced-poll-runner'

/** The first frame: the host's saved list when the renderer already holds it, else the seed,
 *  which shows the quiet placeholder until the host answers. */
function firstFrameOptionState(
  agent: AgentType,
  target: RuntimeClientTarget,
  launch: { newLaunch: boolean; worktree?: string; seedsModel: boolean }
): StructuredAgentSessionOptionState {
  const seed = structuredAgentSessionSeedCatalog(agent)
  const seeded = createStructuredAgentSessionOptionState(agent, seed)
  const snapshot = readHostModelCatalogSnapshot(target, agent, launch)
  return snapshot ? applyStructuredAgentSessionModelCatalog(seeded, seed, snapshot, launch) : seeded
}

/** The picker's catalog and selection for one conversation on its execution host. */
export function useStructuredAgentSessionOptionState(args: {
  agent: AgentType
  optionCatalog: AgentSessionOptionCatalog | null
  identity: string
  fence: number | null
  sessionId: string
  target: RuntimeClientTarget
  /** Whether this is a new chat, where it runs and whether it names its model: what the
   *  host's saved list is read for. */
  newLaunch: boolean
  worktree?: string
  seedsModel: boolean
  providerVisible: boolean
  providerStarting: boolean
  readsBeforeStart: boolean
  hostSelection: Readonly<Record<string, string>> | undefined
  launchSeedOptions: Readonly<Record<string, string>> | undefined
  held: Readonly<Record<string, string>>
  turnId: string | null
  unloadedTurnRevisions: number | undefined
}) {
  const {
    agent,
    fence,
    identity,
    newLaunch,
    optionCatalog,
    seedsModel,
    providerStarting,
    providerVisible,
    readsBeforeStart,
    hostSelection,
    launchSeedOptions,
    held,
    sessionId,
    target,
    turnId,
    worktree
  } = args
  const selectionFromStatus = hostSelection !== undefined
  const [pendingPick, setPendingPick] = useState<{
    generation: number
    values: Readonly<Record<string, string>>
  } | null>(null)
  const [conversationSupport, setConversationSupport] = useState<{
    sessionId: string
    commands: readonly AgentSessionConversationCommand[]
    threadGoal: AgentSessionOptionsResult['threadGoal']
    contextUsage: AgentSessionOptionsResult['contextUsage']
    acceptsImages: boolean | undefined
    rewind: AgentSessionRewindSupport
    /** The fence the read answered for; rewind support is only that runtime's. */
    fence: number | null
  } | null>(null)
  // A revision the loaded window dropped can move the host's whole-journal context facts.
  const contextRefresh = conversationSupport?.contextUsage ? (args.unloadedTurnRevisions ?? 0) : 0
  // The first frame is the final one when the renderer holds the host's list; otherwise the quiet
  // placeholder stands until the host answers, never a built-in label the host may replace.
  const [optionState, setOptionState] = useState(() =>
    firstFrameOptionState(agent, target, {
      newLaunch,
      seedsModel,
      ...(worktree ? { worktree } : {})
    })
  )
  const firstFrameLaunch = useRef({ target, newLaunch, worktree, seedsModel })
  useEffect(() => {
    firstFrameLaunch.current = { target, newLaunch, worktree, seedsModel }
  }, [newLaunch, seedsModel, target, worktree])
  const optionStateRef = useRef(optionState)
  const activeOptionRecordRef = useRef(optionState.record)
  const optionMutationGeneration = useRef(0)
  const updateOptionState = useCallback(
    (update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState) => {
      const next = update(optionStateRef.current)
      optionStateRef.current = next
      setOptionState(next)
    },
    []
  )
  const optionIdentityRef = useRef(identity)
  const activePendingPick =
    optionIdentityRef.current === identity &&
    pendingPick?.generation === optionMutationGeneration.current
      ? pendingPick.values
      : null
  useEffect(() => {
    const previous = optionStateRef.current
    const sameSession = optionIdentityRef.current === identity
    optionIdentityRef.current = identity
    if (sameSession && selectionFromStatus) {
      return
    }
    const launch = firstFrameLaunch.current
    const seeded = firstFrameOptionState(agent, launch.target, {
      newLaunch: launch.newLaunch,
      seedsModel: launch.seedsModel,
      ...(launch.worktree ? { worktree: launch.worktree } : {})
    })
    // The chat's next runtime starts with the picks the host saved, which this view last showed,
    // and a starting agent is not read: keep them, and the account's list, until a read replaces them.
    const next =
      sameSession && previous.catalogSource !== 'seed' && previous.catalogSource !== null
        ? {
            ...previous,
            record: cloneNativeChatSessionOptionRecord(previous.record),
            pendingId: null
          }
        : seeded
    optionMutationGeneration.current += 1
    activeOptionRecordRef.current = next.record
    updateOptionState(() => next)
  }, [agent, fence, identity, selectionFromStatus, updateOptionState])

  const optionsReadRef = useRef<CoalescedPollRunner | null>(null)
  // The read also carries commands, goal, context, image and rewind support. A capable host's
  // selection comes from status even when this metadata read returns an older model.
  useEffect(() => {
    if (!providerVisible || (providerStarting && !readsBeforeStart) || !optionCatalog) {
      return
    }
    let stale = false
    const runner = createCoalescedPollRunner(async () => {
      const readGeneration = optionMutationGeneration.current
      const result = await callStructuredAgentSession<AgentSessionOptionsResult>(
        target,
        'agentSession.options',
        { sessionId }
      )
      if (!stale && optionMutationGeneration.current === readGeneration) {
        setConversationSupport({
          sessionId,
          commands: result.conversationCommands ?? [],
          threadGoal: result.threadGoal,
          contextUsage: result.contextUsage,
          acceptsImages: result.acceptsImages,
          // A host that predates rewind does not name it.
          rewind: result.rewind ?? { supported: false, reason: 'unsupported' },
          fence
        })
        updateOptionState((current) => {
          if (current.record !== activeOptionRecordRef.current) {
            return current
          }
          if (!selectionFromStatus) {
            return applyStructuredAgentSessionOptions(current, optionCatalog, result)
          }
          // A live listing owns choices; only the scoped host catalog owns defaults.
          const configured =
            current.catalogSource !== 'seed' && current.catalog?.defaultModelIsCliDefault
              ? current.catalog.models.find((model) => model.isDefault)
              : undefined
          const effort = configured?.options.find((option) => option.id === 'effort')?.kind
          const catalog = structuredAgentSessionOptionCatalog(optionCatalog, {
            ...result,
            models: result.models.map((model) => ({
              ...model,
              isDefault: model.id === configured?.id,
              ...(model.id === configured?.id &&
              effort?.type === 'select' &&
              effort.defaultIsCliDefault &&
              model.efforts.some((choice) => choice.value === effort.defaultValue)
                ? { defaultEffort: effort.defaultValue }
                : {})
            }))
          })
          if (!configured) {
            delete catalog.defaultModelIsCliDefault
          }
          return { ...current, catalog, catalogSource: 'live' }
        })
      }
    })
    optionsReadRef.current = runner
    runner.run()
    return () => {
      stale = true
      runner.dispose()
    }
  }, [
    fence,
    optionCatalog,
    providerStarting,
    providerVisible,
    readsBeforeStart,
    selectionFromStatus,
    sessionId,
    target,
    turnId,
    updateOptionState
  ])

  // Reads share the session's host queue with sends and interrupts, so a burst of
  // missed revisions keeps one read in flight and at most one behind it.
  const seenContextRefresh = useRef(contextRefresh)
  useEffect(() => {
    if (contextRefresh !== seenContextRefresh.current) {
      seenContextRefresh.current = contextRefresh
      optionsReadRef.current?.run()
    }
  }, [contextRefresh])

  return {
    conversationSupport,
    optionState,
    optionView: useMemo(() => {
      const selected = selectionFromStatus
        ? commitStructuredAgentSessionOptionValues(
            { ...optionState, record: createNativeChatSessionOptionRecord(agent) },
            hostSelection
          )
        : optionState
      return structuredAgentSessionOptionView(
        activePendingPick
          ? commitStructuredAgentSessionOptionValues(selected, activePendingPick)
          : selected,
        selectionFromStatus ? undefined : launchSeedOptions,
        held
      )
    }, [
      agent,
      activePendingPick,
      held,
      hostSelection,
      launchSeedOptions,
      optionState,
      selectionFromStatus
    ]),
    setPendingPick,
    optionStateRef,
    activeOptionRecordRef,
    optionMutationGeneration,
    updateOptionState
  }
}
