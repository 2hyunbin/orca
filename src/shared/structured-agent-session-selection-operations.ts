import {
  STRUCTURED_LAUNCH_OPTION_IDS,
  STRUCTURED_LAUNCH_SEED_OPTION_IDS
} from './native-chat-session-option-defaults'
import { decodeStructuredAgentSessionOptionValue } from './structured-agent-session-option-codec'
import type { NativeChatSessionOptionSettingsMutation } from './native-chat-session-options'
import type { AgentSessionWriteFailure } from './agent-session-write-failure'

export type SelectionOutcome =
  | { kind: 'accepted'; options: Readonly<Record<string, string>> }
  | { kind: 'refused'; failure?: AgentSessionWriteFailure }
  | { kind: 'superseded' }
  | { kind: 'unknown' }

const OPTION_ORDER: readonly string[] = STRUCTURED_LAUNCH_OPTION_IDS

type RememberedPicks = Extract<
  NativeChatSessionOptionSettingsMutation,
  { type: 'apply-picks' }
>['picks']
export type SelectionOperation = {
  identity: number
  key: string
  value: string
  model: string | null
  transmitted: boolean
  outcome?: SelectionOutcome
  result: Promise<SelectionOutcome>
  resolve: (outcome: SelectionOutcome) => void
}

/** Finite operation precedence above a queried host answer; no mutation reply installs a base. */
export function createStructuredSessionSelectionController(
  remember: (picks: RememberedPicks) => void
) {
  let sequence = 0
  let revision = 0
  let adopted = 0
  const inFlight = new Set<Promise<void>>()
  const operations = new Map<number, SelectionOperation>()
  const latest = new Map<string, number>()
  const remembered = new Map<string, number>()
  const listeners = new Set<() => void>()
  const notify = () => {
    revision += 1
    for (const listener of listeners) {
      listener()
    }
  }
  const settle = (operation: SelectionOperation, outcome: SelectionOutcome): void => {
    if (operation.outcome) {
      return
    }
    operation.outcome = outcome
    operation.resolve(outcome)
    if (outcome.kind === 'accepted') {
      const model =
        operation.key === 'model' ? (outcome.options.model ?? operation.model) : operation.model
      const value = decodeStructuredAgentSessionOptionValue(
        operation.key,
        outcome.options[operation.key] ?? operation.value
      )
      const key = operation.key === 'model' ? 'model' : JSON.stringify([model, operation.key])
      if (
        model &&
        value !== null &&
        STRUCTURED_LAUNCH_SEED_OPTION_IDS.some((id) => id === operation.key) &&
        (remembered.get(key) ?? 0) < operation.identity
      ) {
        remembered.set(key, operation.identity)
        const adopt = adopted <= operation.identity
        adopted = Math.max(adopted, operation.identity)
        try {
          remember([
            {
              modelId: model,
              optionId: operation.key,
              value,
              ...(!adopt ? { adoptModelAsLaunchDefault: false } : {})
            }
          ])
        } catch {
          /* Remembering never gates selection. */
        }
      }
    } else if (outcome.kind !== 'unknown') {
      operations.delete(operation.identity)
    }
    notify()
  }
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot: () => revision,
    issue(
      key: string,
      value: string,
      model: string | null,
      offers?: (key: string, value: string) => boolean
    ): SelectionOperation {
      for (const previous of operations.values()) {
        if (
          !previous.transmitted &&
          !previous.outcome &&
          (previous.key === key ||
            (key === 'model' && offers && !offers(previous.key, previous.value)))
        ) {
          settle(previous, { kind: 'superseded' })
        }
      }
      const reply = Promise.withResolvers<SelectionOutcome>()
      const operation = {
        identity: ++sequence,
        key,
        value,
        model: key === 'model' ? value : model,
        transmitted: false,
        result: reply.promise,
        resolve: reply.resolve
      }
      operations.set(operation.identity, operation)
      latest.set(key, operation.identity)
      notify()
      return operation
    },
    overlay(): Record<string, string> {
      return Object.fromEntries(
        [...operations.values()]
          .filter((op) => latest.get(op.key) === op.identity)
          .map((op) => [
            op.key,
            op.outcome?.kind === 'accepted' ? (op.outcome.options[op.key] ?? op.value) : op.value
          ])
      )
    },
    pending(): SelectionOperation[] {
      return [...operations.values()].filter((op) => !op.outcome)
    },
    freeze(replaced: readonly SelectionOperation[] = []): SelectionOperation[] {
      // A definitive create refusal permits a new capture; an ambiguous retry never calls freeze.
      for (const op of replaced) {
        if (!op.outcome && operations.get(op.identity) === op) {
          if (latest.get(op.key) === op.identity) {
            op.transmitted = false
          } else {
            settle(op, { kind: 'superseded' })
          }
        }
      }
      const frozen = [...operations.values()].filter((op) => !op.transmitted && !op.outcome)
      for (const op of frozen) {
        op.transmitted = true
      }
      return frozen
    },
    settle,
    captureRead(): number[] {
      return [...operations.values()].filter((op) => op.outcome).map((op) => op.identity)
    },
    retire(identities: readonly number[]): void {
      for (const identity of identities) {
        operations.delete(identity)
      }
      if (identities.length) {
        notify()
      }
    },
    flush(send: (operation: SelectionOperation) => Promise<SelectionOutcome>): Promise<void> {
      const unsent = [...operations.values()].filter((op) => !op.transmitted && !op.outcome)
      unsent.sort((a, b) => OPTION_ORDER.indexOf(a.key) - OPTION_ORDER.indexOf(b.key))
      for (const operation of unsent) {
        if (operation.outcome || operation.transmitted) {
          continue
        }
        operation.transmitted = true
        const completion = (async () => {
          settle(operation, await send(operation))
        })()
          .catch(() => settle(operation, { kind: 'unknown' }))
          .finally(() => inFlight.delete(completion))
        inFlight.add(completion)
        notify()
      }
      return (async () => {
        while (inFlight.size) {
          await Promise.all(inFlight)
        }
      })()
    },
    abandon(): void {
      for (const operation of operations.values()) {
        settle(operation, { kind: 'superseded' })
      }
      operations.clear()
      latest.clear()
      remembered.clear()
      notify()
    }
  }
}
export type StructuredSessionSelectionController = ReturnType<
  typeof createStructuredSessionSelectionController
>
