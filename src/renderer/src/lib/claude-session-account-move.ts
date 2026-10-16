/**
 * Moves running Claude terminal sessions onto a newly selected Claude account.
 *
 * Why restart + resume is enough: every Orca terminal's `claude` shell function
 * reads the selected account's config folder at launch, so relaunching
 * `claude --resume <id>` in the same pane lands on the new account with the
 * conversation intact. Native chat sessions are not terminal panes and are
 * never touched here.
 */
import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess,
  type RuntimeTerminalProcessInspection
} from '@/runtime/runtime-terminal-inspection'
import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../../shared/agent-process-recognition'
import { normalizeAgentProviderSession } from '../../../shared/agent-session-resume'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import { isClientOnlyUnverifiableInspection } from '../../../shared/terminal-process-inspection'
import type { CodexAccountSelectionTarget } from '../../../shared/codex-selection-lane'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { resolveAgentAccountRestartResumeStartup } from './agent-account-restart-startup'
import {
  getCodexAccountSwitchLaneMatcher,
  isForeignMachineCodexPtyId,
  resolveCodexPaneSelectionLane
} from './codex-pane-selection-lane'

export type ClaudeSessionMoveCandidate = {
  ptyId: string
  tabId: string
  leafId: string
}

type ClaudeSessionMoveState = 'gone' | 'working' | 'ready'

// Panes the user asked to move that were mid-turn; each restarts once its turn ends.
const awaitingTurnEndByPtyId = new Map<string, ClaudeSessionMoveCandidate>()
let unsubscribeAwaitingTurnEnd: (() => void) | null = null

function isClaudeProcess(processName: string | null): boolean {
  return (
    processName !== null &&
    (recognizeAgentProcess(processName)?.agent === 'claude' ||
      isAgentForegroundWrapperProcess(processName))
  )
}

/**
 * Whether Claude, not the shell or another program, holds the pane's foreground.
 *
 * Why the confirm fallback: cached foreground names flap to the shell, and the
 * native macOS install reads as its version folder (`2.1.x`), not `claude`.
 */
async function isClaudeInForeground(
  ptyId: string,
  inspection: RuntimeTerminalProcessInspection
): Promise<boolean> {
  if (isClientOnlyUnverifiableInspection(inspection)) {
    return false
  }
  if (isClaudeProcess(inspection.foregroundProcess)) {
    return true
  }
  return isClaudeProcess(await confirmRuntimeTerminalForegroundProcess(ptyId))
}

function readClaudeSessionMoveState(
  state: AppState,
  candidate: ClaudeSessionMoveCandidate
): ClaudeSessionMoveState {
  if (
    !(state.ptyIdsByTabId[candidate.tabId] ?? []).includes(candidate.ptyId) ||
    state.terminalLayoutsByTabId[candidate.tabId]?.ptyIdsByLeafId?.[candidate.leafId] !==
      candidate.ptyId
  ) {
    return 'gone'
  }
  const entry = state.agentStatusByPaneKey[makePaneKey(candidate.tabId, candidate.leafId)]
  // Why a missing session reads as gone: without an id the restart would start a fresh conversation.
  if (entry?.agentType !== 'claude' || !normalizeAgentProviderSession(entry.providerSession)) {
    return 'gone'
  }
  return entry.state === 'working' ? 'working' : 'ready'
}

/**
 * Finds local terminal panes running a resumable Claude session in the lane the
 * account switch wrote.
 *
 * Why remote owners return nothing: a relay or SSH machine keeps its own Claude
 * login, so a local switch cannot strand those sessions.
 */
export async function findMovableClaudeSessions(args: {
  owner: RuntimeClientTarget
  target: CodexAccountSelectionTarget
}): Promise<ClaudeSessionMoveCandidate[]> {
  if (args.owner.kind !== 'local') {
    return []
  }
  const state = useAppStore.getState()
  const isLaneInScope = getCodexAccountSwitchLaneMatcher({
    owner: args.owner,
    target: args.target
  })
  const candidates: ClaudeSessionMoveCandidate[] = []
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      const boundPtyIds = state.ptyIdsByTabId[tab.id] ?? []
      const leaves = state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}
      for (const [leafId, ptyId] of Object.entries(leaves)) {
        if (
          !ptyId ||
          !isTerminalLeafId(leafId) ||
          !boundPtyIds.includes(ptyId) ||
          isForeignMachineCodexPtyId(ptyId)
        ) {
          continue
        }
        const candidate = { ptyId, tabId: tab.id, leafId }
        const entry = state.agentStatusByPaneKey[makePaneKey(tab.id, leafId)]
        if (entry?.structuredHostOwned || readClaudeSessionMoveState(state, candidate) === 'gone') {
          continue
        }
        if (!isLaneInScope(resolveCodexPaneSelectionLane({ state, tab, ptyId }).laneKey)) {
          continue
        }
        const resumeStartup = resolveAgentAccountRestartResumeStartup('claude', {
          tabId: tab.id,
          leafId,
          worktreeId,
          shellOverride: tab.shellOverride
        })
        if (resumeStartup) {
          candidates.push(candidate)
        }
      }
    }
  }
  const inForeground = await Promise.all(
    candidates.map((candidate) =>
      inspectRuntimeTerminalProcess(candidate.ptyId).then(
        (inspection) => isClaudeInForeground(candidate.ptyId, inspection),
        () => false
      )
    )
  )
  return candidates.filter((_, index) => inForeground[index])
}

/** Drops every move still waiting for a turn to end. */
export function cancelPendingClaudeSessionMoves(): void {
  awaitingTurnEndByPtyId.clear()
  syncAwaitingTurnEndSubscription()
}

/**
 * Restarts idle sessions now and mid-turn sessions when their turn ends.
 *
 * Why wait on 'working': killing Claude mid-reply loses the in-flight turn.
 */
export function moveClaudeSessionsToSelectedAccount(
  candidates: readonly ClaudeSessionMoveCandidate[]
): void {
  awaitingTurnEndByPtyId.clear()
  for (const candidate of candidates) {
    awaitingTurnEndByPtyId.set(candidate.ptyId, candidate)
  }
  flushAwaitingTurnEnd(useAppStore.getState())
  syncAwaitingTurnEndSubscription()
}

function flushAwaitingTurnEnd(state: AppState): void {
  const ready: string[] = []
  for (const [ptyId, candidate] of awaitingTurnEndByPtyId) {
    const moveState = readClaudeSessionMoveState(state, candidate)
    if (moveState === 'working') {
      continue
    }
    awaitingTurnEndByPtyId.delete(ptyId)
    if (moveState === 'ready') {
      ready.push(ptyId)
    }
  }
  state.queueClaudePaneRestarts(ready)
}

function syncAwaitingTurnEndSubscription(): void {
  if (awaitingTurnEndByPtyId.size === 0) {
    unsubscribeAwaitingTurnEnd?.()
    unsubscribeAwaitingTurnEnd = null
    return
  }
  if (unsubscribeAwaitingTurnEnd) {
    return
  }
  unsubscribeAwaitingTurnEnd = useAppStore.subscribe((state, previous) => {
    if (
      state.agentStatusByPaneKey === previous.agentStatusByPaneKey &&
      state.ptyIdsByTabId === previous.ptyIdsByTabId &&
      state.terminalLayoutsByTabId === previous.terminalLayoutsByTabId
    ) {
      return
    }
    flushAwaitingTurnEnd(state)
    syncAwaitingTurnEndSubscription()
  })
}

export function getPendingClaudeSessionMovePtyIdsForTests(): string[] {
  return [...awaitingTurnEndByPtyId.keys()]
}
