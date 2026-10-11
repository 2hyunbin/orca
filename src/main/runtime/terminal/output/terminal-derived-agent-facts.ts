import type { RuntimePtyTitleTrackerEntry } from '../../runtime-terminal-state-records'
import { createCommandCodeOutputStatusDetector } from '../../../../shared/command-code-output-status'

import type { ProcessedAgentStatusChunk } from '../../../../shared/agent-status-osc'
import { mapExplicitAgentStateToRuntimeTerminalStatus } from '../../runtime-worktree-status-projection'
import type { RuntimeTerminalOutputOwner } from './terminal-output-owner'

export function createTerminalSideEffectCommandCodeDetector(
  output: RuntimeTerminalOutputOwner,
  ptyId: string
): NonNullable<RuntimePtyTitleTrackerEntry['commandCodeDetector']> {
  return createCommandCodeOutputStatusDetector({
    startupCommand: output.terminalSpawnCommandsByPtyId.get(ptyId) ?? null,
    onWorking: (prompt) => {
      output.host.recordTerminalSideEffectFact(ptyId, { kind: 'command-code-working', prompt })
    },
    onDone: (prompt) => {
      output.host.recordTerminalSideEffectFact(ptyId, { kind: 'command-code-done', prompt })
    }
  })
}

export function emitTerminalAgentStatusEvents(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  chunk: Pick<ProcessedAgentStatusChunk, 'payloads'> &
    Partial<Pick<ProcessedAgentStatusChunk, 'cleanData' | 'lastPayloadCleanOffset'>>,
  provenance?: { origin: 'process'; yieldsToHookSince: number }
): void {
  if (chunk.payloads.length === 0) {
    return
  }
  const targets = new Map<
    string,
    {
      source: 'mounted-leaf' | 'pty-record'
      paneKey: string
      tabId?: string
      worktreeId?: string
      connectionId?: string | null
      terminalHandle?: string
    }
  >()
  const pty = output.host.ptysById.get(ptyId)
  const connectionId = pty?.connectionId ?? null
  for (const leaf of output.host.getLeavesForPty(ptyId)) {
    const paneKey = output.host.makeRuntimePaneKey(leaf)
    targets.set(paneKey, {
      source: 'mounted-leaf',
      paneKey,
      tabId: leaf.tabId,
      worktreeId: leaf.worktreeId,
      connectionId
    })
  }
  if (targets.size === 0 && pty?.paneKey) {
    targets.set(pty.paneKey, {
      source: 'pty-record',
      paneKey: pty.paneKey,
      tabId: pty.tabId ?? undefined,
      worktreeId: pty.worktreeId,
      connectionId
    })
  }
  // Why once per chunk and not per payload: the same lookup the renderer-facing IPC boundary
  // runs, and it is the pane's only durable join back to its terminal once the pane key moves.
  if (output.host.onTerminalAgentStatus) {
    for (const target of targets.values()) {
      const terminalHandle = output.host.getAgentStatusTerminalHandleForPaneKey(target.paneKey)
      if (terminalHandle) {
        target.terminalHandle = terminalHandle
      }
    }
  }
  for (const payload of chunk.payloads) {
    // Why not gated on a listener: the prompt lifecycle is main's own state, read by
    // terminal waits that run with no status consumer attached.
    output.host.recordAgentPromptLifecycleState(
      ptyId,
      mapExplicitAgentStateToRuntimeTerminalStatus(payload.state)
    )
    for (const target of targets.values()) {
      if (!output.host.onTerminalAgentStatus) {
        continue
      }
      try {
        output.host.invokeTerminalAgentStatus({
          ptyId,
          ...target,
          payload,
          ...provenance
        })
      } catch (err) {
        console.error('[runtime] terminal agent status listener threw', {
          ptyId,
          paneKey: target.paneKey,
          state: payload.state,
          agentType: payload.agentType,
          err
        })
      }
    }
  }
}
