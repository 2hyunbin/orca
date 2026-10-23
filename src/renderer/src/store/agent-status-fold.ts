import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { AppState } from './types'
import type { AgentStatusEntry } from './slices/agent-status-contract'
import type { AgentStatusReadState, AgentStatusSnapshot } from './agent-status-observers'
import type { StoreSetArgs } from './react-commit-cascade-write-probe'
import type { prepareStructuredReadRetirement } from '../components/native-chat/structured-agent-session-read-owner-registry'

export type AgentStatusTransaction = {
  getState: () => AgentStatusReadState
  retireReadOwner: (sessionId: string, target: RuntimeClientTarget) => void
  editEntries: (edit: (entries: Record<string, AgentStatusEntry>) => readonly string[]) => void
  setEntry: (paneKey: string, entry: AgentStatusEntry | undefined) => void
  afterCommit: (effect: () => void) => void
}
export type StatusStage = {
  app: AppState
  appDraft: AppState | null
  appRevision: number
  live: AgentStatusSnapshot
  draft: Record<string, AgentStatusEntry> | null
  dirty: Set<string>
  effects: (() => void)[]
  readRetirement: ReturnType<typeof prepareStructuredReadRetirement> | null
  read: AgentStatusReadState | null
}
export function readAgentStatusFold(stage: StatusStage): AgentStatusReadState {
  stage.read ??= {
    ...stage.app,
    get agentStatusByPaneKey() {
      return stage.draft ?? stage.live
    }
  }
  return stage.read
}

export function writeAgentStatusFold(stage: StatusStage, ...args: StoreSetArgs<AppState>): void {
  const current = stage.app
  const next = typeof args[0] === 'function' ? args[0](current) : args[0]
  if (Object.is(next, current)) {
    return
  }
  stage.appDraft ??= { ...current }
  stage.app = stage.appDraft
  if (args[1] === true) {
    // Replacement removes omitted fields from both private views before installation.
    for (const key of Object.keys(stage.app)) {
      if (!(key in next)) {
        Reflect.deleteProperty(stage.app, key)
        if (stage.read) {
          Reflect.deleteProperty(stage.read, key)
        }
      }
    }
  }
  Object.assign(stage.app, next)
  if (stage.read) {
    Object.assign(stage.read, next)
  }
  stage.appRevision++
}

export function createAgentStatusReadViews() {
  const views = new WeakMap<AppState, WeakMap<AgentStatusSnapshot, AgentStatusReadState>>()
  return (app: AppState, statuses: AgentStatusSnapshot): AgentStatusReadState => {
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
}
