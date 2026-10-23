// The source lifetime composes the same completion interpreter as the window.
import type { AgentPaneChange } from '../agent-hooks/agent-transition-detector'
import { createHookOnlyCompletionObserver } from '../../renderer/src/components/terminal-pane/agent-completion-hook-observer'
import type { AgentCompletionStatusSnapshot } from '../../renderer/src/components/terminal-pane/agent-completion-coordinator-types'
import { createAgentHookNotificationRetirement } from '../../renderer/src/hooks/agent-hook-notification-retirement'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type { LiveNotificationRetirement } from '../../shared/notification-settings-types'

type PaneNews = {
  worktreeId: string
  source: string
  observer: ReturnType<typeof createHookOnlyCompletionObserver>
  retirement: ReturnType<typeof createAgentHookNotificationRetirement>
}

export type TerminalAgentTurnNewsItem = {
  paneKey: string
  worktreeId: string
  row: AgentCompletionStatusSnapshot
}

export type TerminalAgentTurnNewsDeps = {
  readHookRow: (paneKey: string) => AgentStatusIpcPayload | null
  deliver: (news: TerminalAgentTurnNewsItem) => string | undefined
  retire: (alerts: LiveNotificationRetirement[]) => void
}

export class TerminalAgentTurnNews {
  private readonly newsByPane = new Map<string, PaneNews>()
  private readonly titleWorking = new Set<string>()

  constructor(private readonly deps: TerminalAgentTurnNewsDeps) {}

  observe(change: AgentPaneChange): void {
    const { paneKey } = change
    const row = this.deps.readHookRow(paneKey)
    if (change.kind === 'moved' || !row) {
      if (
        !row &&
        ((change.kind === 'moved' && change.to === 'working') ||
          (change.kind === 'seeded' && change.phase === 'working'))
      ) {
        this.titleWorking.add(paneKey)
      }
      if (change.kind === 'moved' && change.to === 'rest') {
        this.titleWorking.delete(paneKey)
        this.forget(paneKey)
      }
      if (!row && change.kind === 'observed') {
        this.forget(paneKey)
      }
      return
    }
    if (!change.workspace || row.structuredHost) {
      this.forget(paneKey)
      return
    }
    if (row.providerSessionOnly || row.programStatusOnly) {
      return
    }
    const worktreeId = change.workspace.worktreeId
    const source = JSON.stringify([
      worktreeId,
      row.connectionId,
      row.terminalHandle,
      row.runId,
      row.executionId,
      row.authorityRestartId,
      row.agentType
    ])
    let news = this.newsByPane.get(paneKey)
    if (news?.source !== source) {
      this.forget(paneKey)
      const workingObserved = this.titleWorking.delete(paneKey)
      const retirement = createAgentHookNotificationRetirement(
        () => row.terminalHandle ?? null,
        this.deps.retire
      )
      const entry: PaneNews = {
        source,
        worktreeId,
        retirement,
        observer: createHookOnlyCompletionObserver({
          paneKey,
          workingObserved,
          isLive: () =>
            this.newsByPane.get(paneKey) === entry && this.deps.readHookRow(paneKey) !== null,
          dispatch: (snapshot) => this.deliver(paneKey, entry, snapshot)
        })
      }
      this.newsByPane.set(paneKey, entry)
      news = entry
      if (
        change.kind === 'observed' &&
        row.state === 'done' &&
        row.turnEndDisposition === undefined &&
        !workingObserved
      ) {
        news.observer.seedHookStatus(row)
        return
      }
    }
    if (change.kind === 'seeded' || row.isReplay || row.restoredUnconfirmed) {
      news.retirement.clear()
      news.observer.seedHookStatus(row)
    } else {
      news.retirement.observe(row)
      news.observer.observeHookStatus(row)
    }
  }

  private forget(paneKey: string): void {
    const news = this.newsByPane.get(paneKey)
    news?.observer.dispose()
    news?.retirement.clear()
    this.newsByPane.delete(paneKey)
  }

  dispose(): void {
    for (const paneKey of this.newsByPane.keys()) {
      this.forget(paneKey)
    }
    this.titleWorking.clear()
  }

  private deliver(paneKey: string, news: PaneNews, snapshot: AgentCompletionStatusSnapshot): void {
    const notificationId = this.deps.deliver({
      paneKey,
      worktreeId: news.worktreeId,
      row: snapshot
    })
    if (notificationId) {
      news.retirement.record({ notificationId }, snapshot)
    }
  }
}
