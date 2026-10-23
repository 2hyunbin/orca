import type { StateCreator, StoreApi } from 'zustand'
import { shallow } from 'zustand/vanilla/shallow'
import type { AppState } from './types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  prepareStructuredReadRetirement,
  installStructuredReadRetirement
} from '../components/native-chat/structured-agent-session-read-owner-registry'
import type { AgentStatusEntry } from './slices/agent-status-contract'
import type { StoreSetArgs } from './react-commit-cascade-write-probe'
import {
  createAgentStatusObservers,
  reportAgentStatusObserverError,
  type AgentStatusReadState,
  type AgentStatusSnapshot
} from './agent-status-observers'

type StatusStage = {
  app: AppState
  live: AgentStatusSnapshot
  draft: Record<string, AgentStatusEntry> | null
  dirty: Set<string>
  effects: (() => void)[]
  readRetirement: ReturnType<typeof prepareStructuredReadRetirement> | null
  read: { app: AppState; view: AgentStatusReadState } | null
}
export type AgentStatusTransaction = {
  getState: () => AgentStatusReadState
  retireReadOwner: (sessionId: string, target: RuntimeClientTarget) => void
  setEntry: (paneKey: string, entry: AgentStatusEntry | undefined) => void
  afterCommit: (effect: () => void) => void
}
export type AgentStatusOwner = ReturnType<typeof createAgentStatusOwner>
const owners = new WeakMap<object, AgentStatusOwner>()

export function getAgentStatusOwner(store: Pick<StoreApi<AppState>, 'getState'>): AgentStatusOwner {
  const owner = owners.get(store.getState)
  if (!owner) {
    throw new Error('Store has no agent-status owner')
  }
  return owner
}

export function afterStoreAcceptance(store: { getState: () => unknown }, effect: () => void): void {
  const owner = owners.get(store.getState)
  if (owner) {
    owner.afterCommit(effect)
  } else {
    effect()
  }
}

function createAgentStatusOwner(rawSet: StoreApi<AppState>['setState'], get: () => AppState) {
  const observers = createAgentStatusObservers()
  let live: AgentStatusSnapshot = {}
  let stage: StatusStage | null = null
  let pending: { app: AppState; accept: () => void } | null = null
  let appDepth = 0
  let coordinatedDepth = 0
  let appFrame: { live: AgentStatusSnapshot } | null = null
  const views = new WeakMap<AppState, WeakMap<AgentStatusSnapshot, AgentStatusReadState>>()
  const joined = (app: AppState, statuses: AgentStatusSnapshot): AgentStatusReadState => {
    let byStatus = views.get(app)
    if (!byStatus) {
      byStatus = new WeakMap()
      views.set(app, byStatus)
    }
    let view = byStatus.get(statuses)
    if (!view) {
      view = { ...app, agentStatusByPaneKey: statuses }
      byStatus.set(statuses, view)
    }
    return view
  }
  const afterCommit = (effect: () => void): void => {
    if (stage) {
      stage.effects.push(effect)
    } else {
      effect()
    }
  }
  const transaction: AgentStatusTransaction = {
    getState: () => {
      if (!stage) {
        return joined(get(), live)
      }
      const prepared = stage
      if (prepared.read?.app !== prepared.app) {
        prepared.read = {
          app: prepared.app,
          view: {
            ...prepared.app,
            get agentStatusByPaneKey() {
              return prepared.draft ?? prepared.live
            }
          }
        }
      }
      return prepared.read.view
    },
    afterCommit,
    retireReadOwner(sessionId, target) {
      if (!stage) {
        throw new Error('Reader retirement requires a transaction')
      }
      stage.readRetirement = prepareStructuredReadRetirement(
        stage.readRetirement,
        sessionId,
        target
      )
    },
    setEntry(paneKey, entry) {
      if (!stage) {
        throw new Error('Live status writes require a transaction')
      }
      if (Object.is((stage.draft ?? stage.live)[paneKey], entry)) {
        return
      }
      stage.draft ??= { ...stage.live }
      stage.dirty.add(paneKey)
      if (entry) {
        stage.draft[paneKey] = entry
      } else {
        delete stage.draft[paneKey]
      }
    }
  }
  const write = (...args: StoreSetArgs<AppState>): void => {
    if (stage) {
      if (args[1] === true) {
        stage.app = typeof args[0] === 'function' ? args[0](stage.app) : args[0]
      } else {
        const next = typeof args[0] === 'function' ? args[0](stage.app) : args[0]
        if (!Object.is(next, stage.app)) {
          stage.app = Object.assign({}, stage.app, next)
        }
      }
      return
    }
    const previousFrame = appFrame
    appFrame = { live }
    appDepth++
    try {
      if (args[1] === true) {
        rawSet(...args)
      } else {
        rawSet(...args)
      }
    } finally {
      appFrame = previousFrame
      appDepth--
      if (appDepth === 0) {
        observers.drain()
      }
    }
  }
  const owner = {
    subscribeEntry: observers.subscribeEntry,
    subscribeAggregate: observers.subscribeAggregate,
    subscribeTransitions: observers.subscribeTransitions,
    getEntry: (paneKey: string): AgentStatusEntry | undefined => live[paneKey],
    getSnapshot: () => live,
    getAppState: () => stage?.app ?? get(),
    afterCommit,
    write,
    isCoordinated: () => coordinatedDepth > 0,
    receipt(app: AppState, previous: AppState): void {
      const install = pending
      pending = null
      if (install?.app === app) {
        install.accept()
      } else {
        const previousLive = appFrame?.live ?? live
        const nextLive = live
        observers.prepare(
          () => joined(previous, previousLive),
          () => joined(app, nextLive),
          new Set(),
          []
        )()
      }
    },
    transact<Result>(operation: (transaction: AgentStatusTransaction) => Result): Result {
      if (stage) {
        return operation(transaction)
      }
      const previous = get()
      const previousLive = live
      const prepared: StatusStage = {
        app: previous,
        live,
        draft: null,
        dirty: new Set(),
        effects: [],
        read: null,
        readRetirement: null
      }
      stage = prepared
      let result: Result
      try {
        result = operation(transaction)
        for (const key of prepared.dirty) {
          if (shallow(previousLive[key], prepared.draft?.[key])) {
            if (prepared.draft && previousLive[key]) {
              prepared.draft[key] = previousLive[key]
            }
            prepared.dirty.delete(key)
          }
        }
        const nextLive = prepared.dirty.size > 0 ? (prepared.draft ?? live) : live
        if (prepared.readRetirement) {
          prepared.effects.push(...prepared.readRetirement.effects)
        }
        stage = null
        if (
          prepared.app !== previous ||
          nextLive !== live ||
          prepared.readRetirement ||
          prepared.effects.length > 0
        ) {
          const accept = observers.prepare(
            () => joined(previous, previousLive),
            () => joined(prepared.app, nextLive),
            prepared.dirty,
            prepared.effects
          )
          coordinatedDepth++
          try {
            const install = prepared.app !== previous ? { app: prepared.app, accept } : null
            pending = install
            live = nextLive
            if (prepared.readRetirement) {
              installStructuredReadRetirement(prepared.readRetirement)
            }
            if (install) {
              appDepth++
              try {
                rawSet(prepared.app, true)
              } finally {
                appDepth--
              }
            } else {
              accept()
            }
          } finally {
            if (appDepth === 0) {
              observers.drain()
            }
            coordinatedDepth--
          }
        }
        return result
      } finally {
        stage = null
      }
    }
  }
  return owner
}

export function withAgentStatusCommit(
  createState: StateCreator<AppState, [], []>
): StateCreator<AppState, [], []> {
  return (set, get, api) => {
    const owner = createAgentStatusOwner(set, get)
    owners.set(api.getState, owner)
    api.subscribe(owner.receipt)
    const subscribe = api.subscribe
    api.subscribe = (listener) =>
      subscribe((...args) => {
        if (!owner.isCoordinated()) {
          listener(...args)
          return
        }
        try {
          listener(...args)
        } catch (error) {
          reportAgentStatusObserverError(error)
        }
      })
    api.setState = owner.write
    return createState(owner.write, owner.getAppState, api)
  }
}
