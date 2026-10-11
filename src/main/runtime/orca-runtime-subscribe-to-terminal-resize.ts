// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import type { TerminalLayoutCommands } from './terminal/layout/terminal-layout-commands'
import { sessionIdFromStructuredWorkerIncarnation } from './structured-worker-identity'
import { observeStructuredWorker } from './rpc/methods/orchestration-structured-worker-lifecycle'
import { OrcaRuntimeWithMarkPtyLivenessUnverifiable } from './orca-runtime-mark-pty-liveness-unverifiable'

import { withTimeoutResult } from './runtime-async-boundaries'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import {
  describeTerminalExitCause,
  isDeliberateTerminalExit
} from '../../shared/terminal-exit-cause'
import {
  DEFAULT_TERMINAL_LIST_LIMIT,
  PTY_CONTROLLER_LIST_TIMEOUT_MS
} from './orca-runtime-postlude'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalOrphanAdoptionRequest,
  RuntimeTerminalOrphanAdoptionResult
} from '../../shared/runtime-types'
import {
  classifyWorkerTerminalProcessIncarnation,
  parseWorkerTerminalHostScope
} from './orchestration/worker-terminal-process-liveness'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { buildOrchestrationTaskDisplayMetadata } from '../../shared/orchestration-task-display'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../shared/execution-host'

export class OrcaRuntimeWithSubscribeToTerminalResize extends OrcaRuntimeWithMarkPtyLivenessUnverifiable {
  subscribeToTerminalResize(
    ...args: Parameters<TerminalLayoutCommands['subscribeToTerminalResize']>
  ): ReturnType<TerminalLayoutCommands['subscribeToTerminalResize']> {
    return this.terminalLayout.commands.subscribeToTerminalResize(...args)
  }

  protected notifyTerminalResize(
    ...args: Parameters<TerminalLayoutCommands['notifyTerminalResize']>
  ): ReturnType<TerminalLayoutCommands['notifyTerminalResize']> {
    return this.terminalLayout.commands.notifyTerminalResize(...args)
  }

  // Why: Section 7.2 — the runtime detects agent exit directly and updates
  // dispatch contexts immediately, rather than waiting for the coordinator's
  // next poll cycle. This catches agent crashes and unexpected exits within
  // milliseconds. The task is set back to 'pending' so it can be re-dispatched.
  protected failActiveDispatchOnExit(
    handle: string,
    paneKey: string | null,
    exitCode: number,
    cause: TerminalExitCause
  ): void {
    if (!this._orchestrationDb) {
      return
    }

    // Why the pane key too: a reminted handle no longer matches the row, but the
    // pane identity behind it outlives the remint.
    const dispatch = this._orchestrationDb.getActiveDispatchForTerminal(
      handle,
      paneKey ?? undefined
    )
    if (!dispatch) {
      return
    }
    // A process that dies while we are stopping it is that stop succeeding, not a failure:
    // settling it as `failed` here made the in-flight worker-stop report its own success as an error.
    // Only a stop begun in THIS runtime can claim the exit; a `stopping` row left durable by a
    // killed process would otherwise absorb a much later crash as a clean stop.
    const stopping = this._orchestrationDb.getWorkerDispatch?.(dispatch.id)
    if (stopping?.state === 'stopping' && stopping.runtime_epoch === this.getRuntimeId()) {
      this._orchestrationDb.settleWorkerStop(dispatch.id)
      return
    }

    const errorContext = describeTerminalExitCause(cause)
    const settled = this._orchestrationDb.failDispatch(dispatch.id, errorContext, {
      workerProcessExited: true,
      terminationReason: cause.kind
    })
    if (isDeliberateTerminalExit(cause)) {
      return
    }

    // Why: create an escalation message so the coordinator is notified about
    // the unexpected exit on its next check cycle, even if the circuit breaker
    // hasn't tripped yet.
    try {
      const owningRun = this._orchestrationDb.getRun?.(dispatch.run_id)
      const active = this._orchestrationDb.getActiveCoordinatorRun?.()
      const recipient =
        owningRun && owningRun.legacy !== 1
          ? { to: `run:${owningRun.id}`, runId: owningRun.id }
          : active
            ? { to: active.coordinator_handle, runId: undefined }
            : null
      if (!recipient) {
        return
      }
      const task = this._orchestrationDb.getTask?.(dispatch.task_id, dispatch.run_id)
      // Why: prefer the explicit task title and keep the derived one single-line and bounded;
      // a raw multi-paragraph spec inlined here breaks the coordinator's escalation banner.
      const title =
        typeof task?.spec === 'string'
          ? buildOrchestrationTaskDisplayMetadata({
              spec: task.spec,
              taskTitle: task.task_title,
              displayName: task.display_name
            }).taskTitle
          : ''
      const named = title ? `"${title}" (${dispatch.task_id})` : dispatch.task_id
      const escalation = this._orchestrationDb.insertMessage({
        from: handle,
        to: recipient.to,
        subject: `Agent exited unexpectedly (${errorContext})`,
        body: `Worker ${handle} stopped while running task ${named}. ${errorContext}.${settled?.status === 'circuit_broken' ? ' This task has now failed too many times, so it will not be retried automatically.' : settled?.status === 'failed' ? ' The task is ready to be dispatched again.' : ''}`,
        type: 'escalation',
        priority: 'high',
        payload: JSON.stringify({
          taskId: dispatch.task_id,
          dispatchId: dispatch.id,
          exitCode,
          exitCause: cause,
          handle
        }),
        runId: dispatch.run_id
      })
      this.notifyMessageArrived(escalation.to_handle, escalation.type)
    } catch (error) {
      console.warn('[orchestration] failed to escalate worker exit', {
        dispatchId: dispatch.id,
        runId: dispatch.run_id,
        error
      })
    }
  }

  async listTerminals(
    worktreeSelector?: string,
    limit = DEFAULT_TERMINAL_LIST_LIMIT,
    opts: {
      handles?: readonly string[]
      requireFreshPtyLiveness?: boolean
      includeVisualLayouts?: boolean
    } = {}
  ): Promise<RuntimeTerminalListResult> {
    return this.terminalList.list(worktreeSelector, limit, opts)
  }

  async inspectTerminalProcessIncarnationLiveness(
    processIncarnation: string,
    serializedHostScope: string | null
  ): Promise<'live' | 'exited' | 'unverifiable'> {
    const structuredSessionId = sessionIdFromStructuredWorkerIncarnation(processIncarnation)
    if (structuredSessionId) {
      // A structured session has no PTY, so the process table can only ever fail to find it —
      // answering `exited` from that absence would release a running provider child. The durable
      // agent-session records, walked forward to any `/clear` successor, are asked directly rather
      // than the in-memory identity registry: settlement forgets the registry entry, so gating on
      // one made a stopped worker's resource answer `unverifiable` forever and stay in
      // `worker-list --terminalState retained` for the life of the DB.
      return observeStructuredWorker({ sessionId: structuredSessionId }).status
    }
    const hostScope = parseWorkerTerminalHostScope(serializedHostScope)
    if (!hostScope || !this.ptyController?.listProcesses) {
      return 'unverifiable'
    }
    const listed = await withTimeoutResult(
      this.ptyController.listProcesses(
        hostScope.kind === 'ssh'
          ? toSshExecutionHostId(hostScope.targetId)
          : LOCAL_EXECUTION_HOST_ID
      ),
      PTY_CONTROLLER_LIST_TIMEOUT_MS
    )
    if (!listed.ok) {
      return 'unverifiable'
    }
    return classifyWorkerTerminalProcessIncarnation(processIncarnation, listed.value)
  }

  protected getTerminalTopologyRevision(worktreeId: string): number {
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    return (
      this.getWorkspaceSessionForWorktree(worktreeId)?.terminalTopologyRevisionByRepoId?.[repoId] ??
      this.terminalTopologyRevisionByRepoId.get(repoId) ??
      0
    )
  }

  async adoptTerminalOrphans(
    request: RuntimeTerminalOrphanAdoptionRequest
  ): Promise<RuntimeTerminalOrphanAdoptionResult> {
    if (request.claims.length === 0) {
      throw new Error('terminal_orphan_claims_required')
    }
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(request.worktree)
    return this.runWorktreeTerminalMutation(workspace.id, async () => {
      const resolvedWorkspace = workspace.folderWorkspace
        ? this.folderWorkspaceToResolvedWorktree(workspace.folderWorkspace)
        : await this.resolveWorktreeSelector(`id:${workspace.id}`)
      const inventory = await this.refreshPtyWorktreeRecordsWithControllerInventory(
        [resolvedWorkspace],
        workspace.id,
        undefined,
        workspace.connectionId ?? null
      )
      if (!inventory) {
        throw new Error('terminal_liveness_unavailable')
      }
      return this.adoptTerminalOrphansFromInventoryUnderMutation(request, workspace, inventory)
    })
  }

  protected applyLayout(
    ...args: Parameters<TerminalLayoutCommands['applyLayout']>
  ): ReturnType<TerminalLayoutCommands['applyLayout']> {
    return this.terminalLayout.commands.applyLayout(...args)
  }

  setMobileDisplayMode(
    ...args: Parameters<TerminalLayoutCommands['setMobileDisplayMode']>
  ): ReturnType<TerminalLayoutCommands['setMobileDisplayMode']> {
    return this.terminalLayout.commands.setMobileDisplayMode(...args)
  }

  getMobileDisplayMode(
    ...args: Parameters<TerminalLayoutCommands['getMobileDisplayMode']>
  ): ReturnType<TerminalLayoutCommands['getMobileDisplayMode']> {
    return this.terminalLayout.commands.getMobileDisplayMode(...args)
  }

  isMobileSubscriberActive(
    ...args: Parameters<TerminalLayoutCommands['isMobileSubscriberActive']>
  ): ReturnType<TerminalLayoutCommands['isMobileSubscriberActive']> {
    return this.terminalLayout.commands.isMobileSubscriberActive(...args)
  }

  updateMobileSubscriberViewport(
    ...args: Parameters<TerminalLayoutCommands['updateMobileSubscriberViewport']>
  ): ReturnType<TerminalLayoutCommands['updateMobileSubscriberViewport']> {
    return this.terminalLayout.commands.updateMobileSubscriberViewport(...args)
  }

  handleMobileSubscribe(
    ...args: Parameters<TerminalLayoutCommands['handleMobileSubscribe']>
  ): ReturnType<TerminalLayoutCommands['handleMobileSubscribe']> {
    return this.terminalLayout.commands.handleMobileSubscribe(...args)
  }

  protected handleMobileSubscribeInternal(
    ...args: Parameters<TerminalLayoutCommands['handleMobileSubscribeInternal']>
  ): ReturnType<TerminalLayoutCommands['handleMobileSubscribeInternal']> {
    return this.terminalLayout.commands.handleMobileSubscribeInternal(...args)
  }

  handleMobileUnsubscribe(
    ...args: Parameters<TerminalLayoutCommands['handleMobileUnsubscribe']>
  ): ReturnType<TerminalLayoutCommands['handleMobileUnsubscribe']> {
    return this.terminalLayout.commands.handleMobileUnsubscribe(...args)
  }

  applyMobileDisplayMode(
    ...args: Parameters<TerminalLayoutCommands['applyMobileDisplayMode']>
  ): ReturnType<TerminalLayoutCommands['applyMobileDisplayMode']> {
    return this.terminalLayout.commands.applyMobileDisplayMode(...args)
  }

  onExternalPtyResize(
    ...args: Parameters<TerminalLayoutCommands['onExternalPtyResize']>
  ): ReturnType<TerminalLayoutCommands['onExternalPtyResize']> {
    return this.terminalLayout.commands.onExternalPtyResize(...args)
  }

  recordRendererGeometry(
    ...args: Parameters<TerminalLayoutCommands['recordRendererGeometry']>
  ): ReturnType<TerminalLayoutCommands['recordRendererGeometry']> {
    return this.terminalLayout.commands.recordRendererGeometry(...args)
  }

  getLastRendererSize(
    ...args: Parameters<TerminalLayoutCommands['getLastRendererSize']>
  ): ReturnType<TerminalLayoutCommands['getLastRendererSize']> {
    return this.terminalLayout.commands.getLastRendererSize(...args)
  }

  protected refreshRendererGeometry(
    ...args: Parameters<TerminalLayoutCommands['refreshRendererGeometry']>
  ): ReturnType<TerminalLayoutCommands['refreshRendererGeometry']> {
    return this.terminalLayout.commands.refreshRendererGeometry(...args)
  }

  isResizeSuppressed(
    ...args: Parameters<TerminalLayoutCommands['isResizeSuppressed']>
  ): ReturnType<TerminalLayoutCommands['isResizeSuppressed']> {
    return this.terminalLayout.commands.isResizeSuppressed(...args)
  }

  protected suppressResizesForMs(
    ...args: Parameters<TerminalLayoutCommands['suppressResizesForMs']>
  ): ReturnType<TerminalLayoutCommands['suppressResizesForMs']> {
    return this.terminalLayout.commands.suppressResizesForMs(...args)
  }
}
