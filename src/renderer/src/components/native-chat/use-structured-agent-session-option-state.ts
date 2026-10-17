import type { StructuredLaunchAcceptedOptions } from '@/lib/structured-agent-session-launch-options'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionConversationCommand } from '../../../../shared/agent-session-conversation-command'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session-wire'
import type { AgentSessionRewindSupport } from '../../../../shared/agent-session-rewind'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { AgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import {
  applyStructuredAgentSessionOptions,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  firstFrameOptionState,
  structuredAgentSessionConfiguredOptionView
} from './structured-agent-session-first-frame-options'
import { acceptStructuredAgentSessionOptionValues } from '../../../../shared/structured-agent-session-option-view'
import { AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import { useStructuredAgentSessionHostCapability } from '@/runtime/structured-agent-session-host-capability'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { cloneNativeChatSessionOptionRecord } from '../../../../shared/native-chat-session-option-state'
import {
  createCoalescedPollRunner,
  type CoalescedPollRunner
} from '../right-sidebar/coalesced-poll-runner'

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
  /** The option values the host's status carries: a pick made on another device moves it. */
  hostOptionStamp: string
  readsBeforeStart: boolean
  hostPermissionMode?: string
  hostSelection: Readonly<Record<string, string>> | undefined
  launchSeedOptions: Readonly<Record<string, string>> | undefined
  held: Readonly<Record<string, string>>
  acceptedOptions?: StructuredLaunchAcceptedOptions
  turnId: string | null
  unloadedTurnRevisions: number | undefined
}) {
  const {
    agent,
    fence,
    hostOptionStamp,
    identity,
    newLaunch,
    optionCatalog,
    seedsModel,
    providerStarting,
    providerVisible,
    readsBeforeStart,
    hostSelection,
    sessionId,
    target,
    turnId,
    worktree
  } = args
  const selectionFromStatus = hostSelection !== undefined
  const [conversationSupport, setConversationSupport] = useState<{
    sessionId: string
    commands: readonly AgentSessionConversationCommand[]
    threadGoal: AgentSessionOptionsResult['threadGoal']
    reportedThreadGoal: AgentSessionOptionsResult['reportedThreadGoal']
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
  const heldPick = useRef<{
    token: object | undefined
    record: typeof optionState.record
    generation: number
    identity: string
    fence: number | null
  } | null>(null)
  const beginLaunchPick = useCallback(
    (token: object | undefined) => {
      const pick = {
        token,
        record: activeOptionRecordRef.current,
        generation: ++optionMutationGeneration.current,
        identity,
        fence
      }
      heldPick.current = pick
      return () =>
        heldPick.current === pick &&
        activeOptionRecordRef.current === pick.record &&
        optionMutationGeneration.current === pick.generation
    },
    [identity, fence]
  )
  const optionsReadRef = useRef<CoalescedPollRunner | null>(null)
  const acceptedPacket = useRef<StructuredLaunchAcceptedOptions | undefined>(undefined)
  if (args.acceptedOptions && acceptedPacket.current !== args.acceptedOptions) {
    acceptedPacket.current = args.acceptedOptions
    const accepted = args.acceptedOptions
    const pick = heldPick.current
    if (
      pick &&
      pick.token === args.acceptedOptions.token &&
      pick.identity === identity &&
      pick.record === activeOptionRecordRef.current &&
      pick.generation === optionMutationGeneration.current &&
      ((fence === null && pick.fence === null) ||
        (fence === accepted.fence && (pick.fence === null || pick.fence === fence)))
    ) {
      pick.fence = accepted.fence
      pick.generation = ++optionMutationGeneration.current
      updateOptionState((current) =>
        acceptStructuredAgentSessionOptionValues(current, accepted.options, hostSelection)
      )
      optionsReadRef.current?.run()
    }
  }
  const optionIdentityRef = useRef(identity)
  useEffect(() => {
    const previous = optionStateRef.current
    const sameSession = optionIdentityRef.current === identity
    optionIdentityRef.current = identity
    if (sameSession && (selectionFromStatus || heldPick.current?.fence === null)) {
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
    const kept =
      sameSession &&
      (previous.record.model !== undefined ||
        (previous.catalogSource !== 'seed' && previous.catalogSource !== null))
        ? {
            ...previous,
            record: cloneNativeChatSessionOptionRecord(previous.record),
            pendingPick: null
          }
        : seeded
    // The chat's own, which a restart for a new mode keeps: the picker never blanks between them.
    const next = sameSession ? { ...kept, permissionMode: previous.permissionMode } : kept
    optionMutationGeneration.current += 1
    activeOptionRecordRef.current = next.record
    updateOptionState(() => next)
  }, [agent, fence, identity, selectionFromStatus, updateOptionState])

  const currentHostStamp = useRef(hostOptionStamp)
  currentHostStamp.current = hostOptionStamp
  // The read also carries commands, goal, context, image and rewind support. A capable host's
  // selection comes from status even when this metadata read returns an older model.
  useEffect(() => {
    if (!providerVisible || (providerStarting && !readsBeforeStart) || !optionCatalog) {
      return
    }
    let stale = false
    const runner = createCoalescedPollRunner(async () => {
      const readGeneration = optionMutationGeneration.current
      const readRecord = activeOptionRecordRef.current
      const readStamp = currentHostStamp.current
      const result = await callStructuredAgentSession<AgentSessionOptionsResult>(
        target,
        'agentSession.options',
        { sessionId }
      )
      if (stale) {
        return
      }
      if (
        optionMutationGeneration.current !== readGeneration ||
        readRecord !== activeOptionRecordRef.current ||
        readStamp !== currentHostStamp.current
      ) {
        runner.run()
        return
      }
      setConversationSupport({
        sessionId,
        commands: result.conversationCommands ?? [],
        threadGoal: result.threadGoal,
        reportedThreadGoal: result.reportedThreadGoal,
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
        return applyStructuredAgentSessionOptions(
          current,
          optionCatalog,
          result,
          selectionFromStatus
        )
      })
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
  const refresh = `${contextRefresh}|${hostOptionStamp}`
  const seenContextRefresh = useRef(refresh)
  useEffect(() => {
    if (refresh !== seenContextRefresh.current) {
      seenContextRefresh.current = refresh
      optionsReadRef.current?.run()
    }
  }, [refresh])

  // An options answer made before the account's listing landed listed none of it.
  const rereadOptions = useCallback(() => optionsReadRef.current?.run(), [])
  const takesSendOptions = useStructuredAgentSessionHostCapability(
    target,
    AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY
  )

  return {
    beginLaunchPick,
    takesSendOptions,
    conversationSupport,
    rereadOptions,
    optionState,
    optionView: useMemo(
      () =>
        structuredAgentSessionConfiguredOptionView(
          args,
          optionState,
          takesSendOptions,
          optionIdentityRef.current === identity
        ),
      [args, identity, optionState, takesSendOptions]
    ),

    optionStateRef,
    activeOptionRecordRef,
    optionMutationGeneration,
    updateOptionState
  }
}
