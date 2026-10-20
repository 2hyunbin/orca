// Layout-owner build: main's starts publish their status on the pane, and a start main could not
// make leaves its pane showing why, whether it failed before the pane was written or after.
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import type * as dependencies from '../../orca-runtime-create-terminal-dependencies'
import { PaneStartStatuses } from '../../pane-start-statuses'
import { admitRuntimePane } from '../../runtime-pane-admission'
import { allocateTerminalPaneIdentity } from '../../runtime-terminal-pane-identity'
import { OrcaRuntimeWithCreateTerminal } from './terminal-create'

export type FailedStartPane = { tabId: string; leafId: string }

/** Runs `start` under ids drawn up front, so a failure at any step can still name its pane. */
export async function startKeepingFailedPane<T>(
  hinted: { tabId?: string; leafId?: string },
  start: (pane: FailedStartPane) => Promise<T>,
  keep: (pane: FailedStartPane, reason: string) => Promise<void>
): Promise<T> {
  const { tabId, leafId } = allocateTerminalPaneIdentity(hinted)
  try {
    return await start({ tabId, leafId })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await keep({ tabId, leafId }, reason).catch((keepError: unknown) => {
      console.warn('[terminal] could not keep the pane of a failed start:', keepError)
    })
    throw error
  }
}

export abstract class OrcaRuntimeWithFailedStartPanes extends OrcaRuntimeWithCreateTerminal {
  protected abstract markPaneLiveTitlesDirty(): void

  /** Switch point: main's starts into panes it already holds, published until each binds. */
  protected readonly paneStartStatuses = ORCA_LAYOUT_OWNER_IS_MAIN
    ? new PaneStartStatuses(() => this.markPaneLiveTitlesDirty())
    : null

  protected paneStartStatusArgs: dependencies.PaneStartArgsOf = (opts) => {
    const sink = this.paneStartStatuses
    return sink
      ? { startStatus: { sink, keepOnFailure: opts.keepPaneOnStartFailure === true } }
      : {}
  }

  override async createTerminal(
    worktreeSelector?: string,
    opts: dependencies.TerminalCreateOptions = {},
    created?: dependencies.Worktree
  ): Promise<dependencies.RuntimeTerminalCreate> {
    // Switch point: a start main could not make leaves its pane showing why, whatever failed.
    if (
      ORCA_LAYOUT_OWNER_IS_MAIN &&
      opts.keepPaneOnStartFailure &&
      worktreeSelector !== undefined
    ) {
      return startKeepingFailedPane(
        opts,
        (pane) =>
          opts.startFailure
            ? Promise.reject(opts.startFailure)
            : super.createTerminal(worktreeSelector, { ...opts, ...pane }, created),
        (pane, reason) => this.keepFailedStartPane(worktreeSelector, created, pane, opts, reason)
      )
    }
    return super.createTerminal(worktreeSelector, opts, created)
  }

  private async keepFailedStartPane(
    worktreeSelector: string,
    created: dependencies.Worktree | undefined,
    pane: FailedStartPane,
    { title }: dependencies.TerminalCreateOptions,
    reason: string
  ): Promise<void> {
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(worktreeSelector, created)
    const hostId = workspace.connectionId ? toSshExecutionHostId(workspace.connectionId) : undefined
    const admission = { type: 'createTerminalTab' as const, workspace: workspace.id, ...pane }
    const outcome = await admitRuntimePane(
      this.store,
      title ? { ...admission, title } : admission,
      hostId
    )
    if (outcome === 'admitted' || outcome === 'exists') {
      this.paneStartStatuses?.set(`${pane.tabId}:${pane.leafId}`, { status: 'failed', reason })
    }
  }
}
