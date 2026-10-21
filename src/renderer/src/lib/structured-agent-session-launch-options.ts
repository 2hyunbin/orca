import { useSyncExternalStore } from 'react'
import { structuredSessionSelectionController } from './structured-agent-session-selection-controller'
import type {
  SelectionOperation,
  SelectionOutcome
} from '../../../shared/structured-agent-session-selection-operations'
import { structuredAgentSessionOptionPicks } from '../../../shared/structured-agent-session-options'
import type {
  AgentSessionMutationResult,
  AgentSessionOptionResult
} from '../../../shared/agent-session-wire'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../shared/structured-agent-session-mutation'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  StructuredAgentSessionLaunchCancelledError,
  type StructuredAgentLaunchReceipt
} from './structured-agent-session-launch-recovery'
import {
  getStructuredLaunchStateBySessionId,
  notifyStructuredLaunchListeners,
  subscribeStructuredAgentLaunchStatus,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'
import {
  agentSessionRefusalFailure,
  agentSessionThrownFailure
} from '../../../shared/agent-session-write-failure'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { StructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'
import {
  structuredAgentSessionModelOffers,
  type StructuredAgentSessionOptionState
} from '../../../shared/structured-agent-session-options'

/** The options a launch starts with, replaced whole so readers can compare by identity. */
export type StructuredLaunchSelection = {
  /** The immutable create seed, until a queried host answer replaces it. */
  seed?: Readonly<Record<string, string>>
  /** Encoded picks made before publish; the launch applies them before it publishes. */
  held: Readonly<Record<string, string>>
  /** A paired server has not yet said what create seeds, so nothing can be picked against it. */
  seedPending?: true
}

export function initialStructuredLaunchSelection(
  intent: StructuredAgentSessionLaunchIntent
): StructuredLaunchSelection {
  return {
    seed: intent.seedOptions,
    held: {},
    ...(intent.target.kind !== 'local' && !intent.seedOptions ? { seedPending: true } : {})
  }
}

export type StructuredLaunchOptionOutcome = SelectionOutcome

const launchControllers = new WeakMap<
  StructuredLaunchState,
  ReturnType<typeof structuredSessionSelectionController>
>()
const selectionController = (state: StructuredLaunchState) => {
  let controller = launchControllers.get(state)
  if (!controller) {
    controller = structuredSessionSelectionController(
      state.intent.target,
      state.intent.sessionId,
      state.intent.agent
    )
    launchControllers.set(state, controller)
  }
  return controller
}
const receipts = new WeakMap<StructuredLaunchState, StructuredAgentLaunchReceipt>()
const subscribed = new WeakSet<StructuredLaunchState>()
function observeSelection(state: StructuredLaunchState): void {
  if (subscribed.has(state)) {
    return
  }
  subscribed.add(state)
  const unsubscribe = selectionController(state).subscribe(() => {
    state.selection = {
      ...state.selection,
      held: Object.fromEntries(
        selectionController(state)
          .pending()
          .map((op) => [op.key, op.value])
      )
    }
    notifyStructuredLaunchListeners()
    if (state.cancelled || state.callers.outcome === 'published') {
      unsubscribe()
    }
    state.callers.onSettled()
  })
}

/**
 * Records a pick made while the launch has no fence to send it against. Null once the launch
 * has published or is gone: the pick then goes through the session like any other.
 */
export function holdStructuredAgentSessionLaunchOption(
  sessionId: string,
  id: string,
  encoded: string,
  /** The picker's list, under which a model pick keeps only the held values the model offers. */
  picker?: StructuredAgentSessionOptionState
): Promise<StructuredLaunchOptionOutcome> | null {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  if (!state || state.cancelled || state.callers.outcome === 'published') {
    return null
  }
  if (state.selection.seedPending) {
    return null
  }
  observeSelection(state)
  const model = picker
    ? (structuredAgentSessionOptionPicks(picker, { [id]: encoded })[0]?.modelId ?? null)
    : (state.selection.seed?.model ?? null)
  const operation = selectionController(state).issue(
    id,
    encoded,
    model,
    (key, value) => !picker || structuredAgentSessionModelOffers(picker, encoded, key, value)
  )
  const receipt = receipts.get(state)
  if (receipt) {
    void applyStructuredLaunchHeldOptions(state, receipt)
  }
  return operation.result
}

export async function setStructuredSessionSelectionOption(
  target: RuntimeClientTarget,
  sessionId: string,
  fence: number,
  key: string,
  value: string
): Promise<StructuredLaunchOptionOutcome> {
  const fields = { key, value }
  try {
    const result = await callStructuredAgentSession<
      AgentSessionMutationResult<AgentSessionOptionResult>
    >(target, 'agentSession.setOption', {
      envelope: {
        sessionId,
        clientOperationId: createStructuredAgentSessionOperationId(createBrowserUuid),
        expectedRuntimeFence: fence,
        payloadFingerprint: structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.setOption',
          sessionId,
          fields
        })
      },
      ...fields
    })
    return result.ok
      ? { kind: 'accepted', options: result.value.options ?? { [key]: value } }
      : { kind: 'refused', failure: agentSessionRefusalFailure(result.refusal) }
  } catch (error) {
    const failure = agentSessionThrownFailure(
      error,
      error instanceof RuntimeRpcCallError ? error.code : undefined
    )
    return failure.kind === 'unconfirmed' ? { kind: 'unknown' } : { kind: 'refused', failure }
  }
}

const createHeld = new WeakMap<StructuredLaunchState, readonly SelectionOperation[]>()

/** Freeze identities, so a later equal-valued choice is a distinct operation. */
export function holdStructuredLaunchCreatePicks(
  state: StructuredLaunchState,
  _held: Readonly<Record<string, string>>
): void {
  createHeld.set(state, selectionController(state).freeze(createHeld.get(state)))
}

export function settleStructuredLaunchCreateOptions(
  state: StructuredLaunchState,
  options: Readonly<Record<string, string>>
): void {
  for (const operation of createHeld.get(state) ?? []) {
    selectionController(state).settle(operation, { kind: 'accepted', options })
  }
  createHeld.delete(state)
}

/** Enqueue the current batch before attachment; later picks use this same ordered sender. */
export async function applyStructuredLaunchHeldOptions(
  state: StructuredLaunchState,
  receipt: StructuredAgentLaunchReceipt
): Promise<StructuredAgentLaunchReceipt> {
  receipts.set(state, receipt)
  await selectionController(state).flush(async (operation) => {
    if (state.cancelled) {
      throw new StructuredAgentSessionLaunchCancelledError()
    }
    return setStructuredSessionSelectionOption(
      state.intent.target,
      state.intent.sessionId,
      receipt.fence,
      operation.key,
      operation.value
    )
  })
  return receipt
}

export function getStructuredAgentSessionLaunchSelection(
  sessionId: string
): StructuredLaunchSelection | null {
  return getStructuredLaunchStateBySessionId(sessionId)?.selection ?? null
}

/** The launch's selection while it is in the registry; null before and after. */
export function useStructuredAgentSessionLaunchSelection(
  sessionId: string
): StructuredLaunchSelection | null {
  return useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => getStructuredAgentSessionLaunchSelection(sessionId),
    () => null
  )
}
