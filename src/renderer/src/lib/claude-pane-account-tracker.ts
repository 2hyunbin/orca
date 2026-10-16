/**
 * Best-known Claude account per terminal pane.
 *
 * Why renderer-side inference: a pane's `claude` shell function reads the
 * selected account's folder at launch, and no existing channel reports that
 * folder back per pane. So a session first seen after startup is attributed to
 * its lane's selection at that moment, and Orca's own restarts record the
 * account they relaunch on. Anything else (sessions restored at startup, a new
 * session id in a pane we already knew) is unknown, and callers treat unknown
 * as "still on the outgoing account" — an extra restart offer beats silently
 * leaving a session stranded.
 */
import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import { normalizeAgentProviderSession } from '../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { resolveCodexPaneSelectionLane } from './codex-pane-selection-lane'

type ClaudePaneAccount = { id: string | null } | 'unknown'

type ClaudePaneAccountRecord = { sessionId: string; account: ClaudePaneAccount }

const recordsByPaneKey = new Map<string, ClaudePaneAccountRecord>()
let baselineTaken = false

const HOST_LANE_KEY = 'host'
const WSL_LANE_PREFIX = 'wsl:'

/** The Claude account a lane launches with right now; undefined for lanes Orca does not select. */
export function getSelectedClaudeAccountIdForLane(
  settings: AppState['settings'],
  laneKey: string
): string | null | undefined {
  if (!settings) {
    return undefined
  }
  const selection = settings.activeClaudeManagedAccountIdsByRuntime
  if (laneKey === HOST_LANE_KEY) {
    return selection?.host ?? settings.activeClaudeManagedAccountId ?? null
  }
  if (laneKey.startsWith(WSL_LANE_PREFIX)) {
    return selection?.wsl?.[laneKey.slice(WSL_LANE_PREFIX.length)] ?? null
  }
  return undefined
}

function readClaudeSessionId(state: AppState, paneKey: string): string | null {
  const entry = state.agentStatusByPaneKey[paneKey]
  if (entry?.agentType !== 'claude') {
    return null
  }
  return normalizeAgentProviderSession(entry.providerSession)?.id ?? null
}

function resolveLaneAccount(state: AppState, paneKey: string): ClaudePaneAccount {
  const parsed = parsePaneKey(paneKey)
  const ptyId = parsed
    ? state.terminalLayoutsByTabId[parsed.tabId]?.ptyIdsByLeafId?.[parsed.leafId]
    : undefined
  const tab = parsed
    ? Object.values(state.tabsByWorktree)
        .flat()
        .find((candidate) => candidate.id === parsed.tabId)
    : undefined
  if (!tab || !ptyId) {
    return 'unknown'
  }
  const laneKey = resolveCodexPaneSelectionLane({ state, tab, ptyId }).laneKey
  const accountId = getSelectedClaudeAccountIdForLane(state.settings, laneKey)
  return accountId === undefined ? 'unknown' : { id: accountId }
}

function observeClaudeSessions(state: AppState): void {
  if (!state.settings) {
    return
  }
  const takingBaseline = !baselineTaken
  baselineTaken = true
  for (const paneKey of Object.keys(state.agentStatusByPaneKey)) {
    const sessionId = readClaudeSessionId(state, paneKey)
    if (!sessionId) {
      continue
    }
    const existing = recordsByPaneKey.get(paneKey)
    if (existing?.sessionId === sessionId) {
      continue
    }
    // Why unknown for a changed id: /clear keeps the old process (and account) under a new id.
    const account = takingBaseline || existing ? 'unknown' : resolveLaneAccount(state, paneKey)
    recordsByPaneKey.set(paneKey, { sessionId, account })
  }
}

function pruneClosedTabs(state: AppState): void {
  const liveTabIds = new Set(
    Object.values(state.tabsByWorktree)
      .flat()
      .map((tab) => tab.id)
  )
  for (const paneKey of recordsByPaneKey.keys()) {
    const tabId = parsePaneKey(paneKey)?.tabId
    if (!tabId || !liveTabIds.has(tabId)) {
      recordsByPaneKey.delete(paneKey)
    }
  }
}

/** Installed once at app startup; returns the uninstaller. */
export function installClaudePaneAccountTracker(): () => void {
  observeClaudeSessions(useAppStore.getState())
  return useAppStore.subscribe((state, previous) => {
    if (
      state.agentStatusByPaneKey !== previous.agentStatusByPaneKey ||
      state.settings !== previous.settings
    ) {
      observeClaudeSessions(state)
    }
    if (state.tabsByWorktree !== previous.tabsByWorktree) {
      pruneClosedTabs(state)
    }
  })
}

/** Records the account a pane's current Claude session now runs on. */
export function recordClaudePaneAccount(paneKey: string, accountId: string | null): void {
  const sessionId = readClaudeSessionId(useAppStore.getState(), paneKey)
  if (sessionId) {
    recordsByPaneKey.set(paneKey, { sessionId, account: { id: accountId } })
  }
}

/** True unless the pane is known to run on an account other than `accountId`. */
export function mayBeOnClaudeAccount(paneKey: string, accountId: string | null): boolean {
  const record = recordsByPaneKey.get(paneKey)
  if (!record || record.account === 'unknown') {
    return true
  }
  return record.account.id === accountId
}

export function resetClaudePaneAccountTrackerForTests(): void {
  recordsByPaneKey.clear()
  baselineTaken = false
}
