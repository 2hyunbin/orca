import {
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-ipc-payload'
import type { AgentProcessVerdict } from '../../../../shared/agent-process-presence'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'

/** Per slept PTY: the resume records captured, and the panes whose agent the hook store proved exited. */
export type WorktreeSleepResumeCapture = Map<
  string,
  { exitedPaneKeys: string[]; records: SleepingAgentSessionRecord[] }
>

/** Captures before a host-driven sleep stops its PTYs and persists for the ones proven stopped. */
export type WorktreeSleepResumeRecorder = {
  capture(worktreeId: string, ptyIds: ReadonlySet<string>): Promise<WorktreeSleepResumeCapture>
  persist(worktreeId: string, capture: WorktreeSleepResumeCapture, stoppedPtyIds: string[]): void
}

/**
 * Builds the records a host-driven sleep leaves behind, from the host's own hook store.
 * Why: a paired client's sleep stops the host's PTYs, but the record its renderer writes never
 * reaches the host — and the host is the side that answers the tab open (session.tabs.activate),
 * so without these the reopened tab is a plain shell.
 */
export async function captureWorktreeSleepResumeRecords(args: {
  worktreeId: string
  paneKeysByPtyId: ReadonlyMap<string, Iterable<string>>
  /** The agent each PTY was launched as, with its recipe; resume must reuse a custom binary/args. */
  launchByPtyId: ReadonlyMap<
    string,
    { agent: string | null; config: SleepingAgentLaunchConfig | null }
  >
  rows: readonly AgentStatusIpcPayload[]
  checkAgentPresence:
    | ((paneKey: string, exitedSince?: number) => Promise<AgentProcessVerdict | null>)
    | null
  capturedAt: number
}): Promise<WorktreeSleepResumeCapture> {
  const capture: WorktreeSleepResumeCapture = new Map()
  for (const [ptyId, keys] of args.paneKeysByPtyId) {
    const panes = [...new Set(keys)].flatMap((paneKey) => {
      const pane = parsePaneKey(paneKey)
      return pane ? [{ paneKey, tabId: pane.tabId }] : []
    })
    const records: SleepingAgentSessionRecord[] = []
    const exitedPaneKeys: string[] = []
    const launch = args.launchByPtyId.get(ptyId)
    for (const { paneKey, tabId } of panes) {
      // Why: the one holder rule — an agent the hook store proved exited left a plain shell.
      if ((await args.checkAgentPresence?.(paneKey, 0).catch(() => null)) === 'exited') {
        exitedPaneKeys.push(paneKey)
        continue
      }
      const row = args.rows.find((candidate) => candidate.paneKey === paneKey)
      const agent = row?.agentType
      const providerSession = normalizeAgentProviderSession(row?.providerSession)
      if (!row || !isResumableTuiAgent(agent) || !providerSession) {
        continue
      }
      records.push({
        paneKey,
        tabId,
        worktreeId: args.worktreeId,
        agent,
        providerSession,
        prompt: row.prompt,
        // Why done: a pane-owned capture whose `--resume` waits for the tab open (#11598).
        state: 'done',
        capturedAt: args.capturedAt,
        updatedAt: row.receivedAt,
        origin: 'worktree-sleep',
        restoreOnTabOpenOnly: true,
        ...(launch?.config && launch.agent === agent ? { launchConfig: launch.config } : {})
      })
    }
    capture.set(ptyId, { exitedPaneKeys, records })
  }
  return capture
}

/** The session with the stopped panes' records replaced, or null when nothing changes. */
export function applyWorktreeSleepResumeRecords(
  session: WorkspaceSessionState,
  capture: WorktreeSleepResumeCapture,
  stoppedPtyIds: readonly string[]
): WorkspaceSessionState | null {
  const next = { ...session.sleepingAgentSessionsByPaneKey }
  let changed = false
  for (const ptyId of stoppedPtyIds) {
    const entry = capture.get(ptyId)
    for (const paneKey of entry?.exitedPaneKeys ?? []) {
      // Why: only a proven exit retires an older capture; a missing hook row (an agent still
      // starting after a resume) is no evidence the session left the pane.
      if (next[paneKey]) {
        delete next[paneKey]
        changed = true
      }
    }
    for (const record of entry?.records ?? []) {
      next[record.paneKey] = record
      changed = true
    }
  }
  return changed ? { ...session, sleepingAgentSessionsByPaneKey: next } : null
}
