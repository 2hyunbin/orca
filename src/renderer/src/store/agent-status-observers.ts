import type { AgentStatusEntry } from './slices/agent-status-contract'
import type { AppState } from './types'

export type AgentStatusSnapshot = Readonly<Record<string, AgentStatusEntry>>
export type AgentStatusReadState = AppState & { agentStatusByPaneKey: AgentStatusSnapshot }
export type AgentStatusTransition = {
  sequence: number
  previous: AgentStatusReadState
  next: AgentStatusReadState
  changedKeys: ReadonlySet<string>
}
type Subscription<T> = { active: boolean; listener: T }

export function reportAgentStatusObserverError(error: unknown): void {
  try {
    console.warn('[agent-status] accepted observer failed', error)
  } catch {
    // Diagnostics cannot interrupt accepted work.
  }
}

export function createAgentStatusObservers() {
  const entries = new Map<string, Set<Subscription<() => void>>>()
  const aggregates = new Set<Subscription<() => void>>()
  const transitions = new Set<
    Subscription<(transition: AgentStatusTransition) => void> & { paneKey?: string }
  >()
  const queue: (() => void)[] = []
  let draining = false
  let sequence = 0
  const subscribe = <T>(bucket: Set<Subscription<T>>, listener: T): (() => void) => {
    const subscription = { active: true, listener }
    bucket.add(subscription)
    return () => {
      subscription.active = false
      bucket.delete(subscription)
    }
  }
  const call = (effect: () => void): void => {
    try {
      effect()
    } catch (error) {
      reportAgentStatusObserverError(error)
    }
  }
  return {
    subscribeEntry(paneKey: string, listener: () => void): () => void {
      let bucket = entries.get(paneKey)
      if (!bucket) {
        bucket = new Set()
        entries.set(paneKey, bucket)
      }
      const unsubscribe = subscribe(bucket, listener)
      return () => {
        unsubscribe()
        if (bucket.size === 0 && entries.get(paneKey) === bucket) {
          entries.delete(paneKey)
        }
      }
    },
    subscribeAggregate: (listener: () => void) => subscribe(aggregates, listener),
    subscribeTransitions(
      listener: (transition: AgentStatusTransition) => void,
      paneKey?: string
    ): () => void {
      const subscription = { active: true, listener, paneKey }
      transitions.add(subscription)
      return () => {
        subscription.active = false
        transitions.delete(subscription)
      }
    },
    prepare(
      previous: AgentStatusReadState,
      next: AgentStatusReadState,
      changedKeys: ReadonlySet<string>,
      effects: readonly (() => void)[]
    ): () => void {
      const points = [...changedKeys].flatMap((key) => [...(entries.get(key) ?? [])])
      const aggregate = changedKeys.size > 0 ? [...aggregates] : []
      const paired = [...transitions].filter(
        (subscription) =>
          subscription.paneKey === undefined || changedKeys.has(subscription.paneKey)
      )
      const transition: AgentStatusTransition = { sequence: 0, previous, next, changedKeys }
      const deliver = (): void => {
        for (const subscription of [...points, ...aggregate]) {
          if (subscription.active) {
            call(subscription.listener)
          }
        }
        for (const subscription of paired) {
          if (subscription.active) {
            call(() => subscription.listener(transition))
          }
        }
        for (const effect of effects) {
          call(effect)
        }
      }
      return () => {
        transition.sequence = ++sequence
        queue.push(deliver)
      }
    },
    drain(): void {
      if (draining) {
        return
      }
      draining = true
      try {
        for (let index = 0; index < queue.length; index++) {
          queue[index]()
        }
      } finally {
        queue.length = 0
        draining = false
      }
    }
  }
}
