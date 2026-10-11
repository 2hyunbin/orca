import type {
  RuntimeTerminalAgentStatusSnapshot,
  RuntimeTerminalAgentStatusQuery
} from '../../runtime-terminal-agent-status-query'
import { type AgentStatus, isOpenCodeNativeTitle } from '../../../../shared/agent-detection'
import type { RuntimeTerminalWaitBlockedReason } from '../../../../shared/runtime-types'
import { detectTerminalWaitBlockedReason } from '../../terminal-wait-detection'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import {
  getDisplayPromptLifecycle,
  type TitleDisplayClear
} from '../../runtime-worktree-status-projection'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { hasExplicitIdleTitle } from '../../tui-idle-evidence'
import { readTuiIdleHookTurn, type TuiIdleHookTurn } from '../../tui-idle-hook-lane'

type TerminalWaitPermissionHost = {
  getPty(ptyId: string): RuntimePtyWorktreeRecord | undefined
  getPtyTitleDisplayClear(ptyId: string): TitleDisplayClear | null
  getPromptLifecycle(ptyId: string): { status: AgentStatus | null; updatedAt: number } | undefined
  getExistingTerminalHandlesForPtyId(ptyId: string): string[]
  collectPaneKeysForPty(ptyId: string): Set<string>
  getAgentStatusSnapshotForPane(): ((paneKey: string) => AgentStatusIpcPayload[]) | null
  getAgentStatusSnapshot(): AgentStatusIpcPayload[] | undefined
  getExplicitStatusFloor(ptyId: string): number | undefined
  readLastInputAt(ptyId: string): number | null
  getPtyHandle(ptyId: string): string | undefined
  getTerminalAgentStatusSnapshot(handle: string, ptyId: string): RuntimeTerminalAgentStatusSnapshot
}

export class TerminalWaitPermission {
  constructor(
    private readonly host: TerminalWaitPermissionHost,
    private readonly terminalAgentStatus: Pick<RuntimeTerminalAgentStatusQuery, 'getSnapshot'>
  ) {}

  resolveAuthoritativeTerminalWaitPermission(
    terminal: RuntimeTerminalAgentStatusSnapshot,
    explicitStatus: { status: AgentStatus; updatedAt: number } | null,
    lifecycle: { status: AgentStatus | null; updatedAt: number } | null | undefined
  ): RuntimeTerminalWaitBlockedReason | null {
    const blockedByWaitText = detectTerminalWaitBlockedReason(terminal.waitText)
    if (!blockedByWaitText) {
      return null
    }
    const liveTitleClearsBlockedText =
      terminal.titleStatusIsLive &&
      terminal.titleStatus !== null &&
      terminal.titleStatus !== 'permission' &&
      !isOpenCodeNativeTitle(terminal.title) &&
      blockedByWaitText !== 'agent-approval-prompt'
    if (liveTitleClearsBlockedText && lifecycle?.status !== terminal.titleStatus) {
      return null
    }
    if (blockedByWaitText === 'agent-approval-prompt') {
      return blockedByWaitText
    }
    const newestPermissionAt = Math.max(
      explicitStatus?.status === 'permission' ? explicitStatus.updatedAt : -1,
      lifecycle?.status === 'permission' ? lifecycle.updatedAt : -1,
      terminal.waitBlockedAt ?? -1
    )
    const newestClearAt = Math.max(
      explicitStatus && explicitStatus.status !== 'permission' ? explicitStatus.updatedAt : -1,
      lifecycle?.status && lifecycle.status !== 'permission' ? lifecycle.updatedAt : -1
    )
    return newestPermissionAt >= 0 && newestPermissionAt >= newestClearAt ? blockedByWaitText : null
  }

  // Compare the same display-cleared title and lifecycle that the pane shows.
  getTerminalWaitPermissionInputs(
    handle: string,
    ptyId: string,
    waitTextOverride?: string
  ): {
    terminal: RuntimeTerminalAgentStatusSnapshot
    lifecycle: { status: AgentStatus | null; updatedAt: number } | null | undefined
  } {
    const clear = this.host.getPtyTitleDisplayClear(ptyId)
    const snapshot = this.terminalAgentStatus.getSnapshot(handle, ptyId, clear)
    return {
      terminal:
        waitTextOverride === undefined ? snapshot : { ...snapshot, waitText: waitTextOverride },
      lifecycle: getDisplayPromptLifecycle(this.host.getPromptLifecycle(ptyId), clear)
    }
  }

  /** The pane's main-agent turn from the hook server's store, for tui-idle's hook lane. */
  readTuiIdleHookTurnForPty(ptyId: string, agent: TuiAgent): TuiIdleHookTurn | null {
    const pty = this.host.getPty(ptyId)
    if (!pty) {
      return null
    }
    const handles = this.host.getExistingTerminalHandlesForPtyId(ptyId)
    const paneKeys = this.host.collectPaneKeysForPty(ptyId)
    if (pty.paneKey) {
      paneKeys.add(pty.paneKey)
    }
    const readPane = this.host.getAgentStatusSnapshotForPane()
    const hookRows = readPane
      ? [...new Set([...paneKeys].flatMap((key) => readPane(key)))]
      : this.host.getAgentStatusSnapshot()
    if (!hookRows) {
      return null
    }
    return readTuiIdleHookTurn({
      agent,
      handles,
      paneKeys,
      hookRows,
      connectionId: pty.connectionId,
      wslDistro: pty.wslDistro,
      launchToken: pty.launchToken,
      titleObservedAtEpochMs: pty.lastOscTitleEpochMs,
      hasExplicitIdleTitle: hasExplicitIdleTitle(pty),
      respawnedAt: this.host.getExplicitStatusFloor(ptyId),
      lastInputAt: this.host.readLastInputAt(ptyId),
      resolveBlockedText: (state, row) =>
        this.resolveTuiIdleHookBlockedText(ptyId, handles, state, row)
    })
  }

  private resolveTuiIdleHookBlockedText(
    ptyId: string,
    handles: readonly string[],
    state: 'done' | 'working' | 'permission',
    row: AgentStatusIpcPayload
  ): RuntimeTerminalWaitBlockedReason | null {
    const handle = this.host.getPtyHandle(ptyId) ?? handles[0]
    if (!handle) {
      return null
    }
    try {
      return this.resolveAuthoritativeTerminalWaitPermission(
        this.host.getTerminalAgentStatusSnapshot(handle, ptyId),
        { status: state === 'done' ? 'idle' : state, updatedAt: row.receivedAt },
        this.host.getPromptLifecycle(ptyId)
      )
    } catch {
      // A handle that no longer targets this PTY has no text to judge.
      return null
    }
  }
}
