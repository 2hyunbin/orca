import type { AgentStatusTransition } from '@/store/agent-status-observers'
import { getTerminalTabOwners } from '@/store/slices/terminal-tab-owner-index'
import { getCachedTerminalTabForWorktree } from '@/components/terminal-pane/terminal-tab-lookup'
import { parsePaneKey, parseLegacyNumericPaneKey } from '../../../shared/stable-pane-id'
import { haveSameTerminalRoutingInputs } from './terminal-agent-routing-inputs'
import { worktreeUsesRemoteConnection } from '@/store/terminals/terminal-workspace-routing'

export function affectedExitEvidenceTabs({
  previous,
  next,
  changedKeys,
  terminalFacts
}: AgentStatusTransition): ReadonlySet<string> {
  const affected = new Set<string>()
  const addPane = (key: string): void => {
    const id = parsePaneKey(key)?.tabId ?? parseLegacyNumericPaneKey(key)?.tabId
    if (id) {
      affected.add(id)
    }
  }
  for (const key of changedKeys) {
    addPane(key)
  }
  if (previous.tabsByWorktree !== next.tabsByWorktree) {
    const hints = terminalFacts.tabsByWorktree
    if (hints) {
      for (const id of hints) {
        affected.add(id)
      }
    } else {
      for (const workspace of new Set([
        ...Object.keys(previous.tabsByWorktree),
        ...Object.keys(next.tabsByWorktree)
      ])) {
        if (previous.tabsByWorktree[workspace] === next.tabsByWorktree[workspace]) {
          continue
        }
        for (const tab of [
          ...(previous.tabsByWorktree[workspace] ?? []),
          ...(next.tabsByWorktree[workspace] ?? [])
        ]) {
          if (
            getCachedTerminalTabForWorktree(previous.tabsByWorktree, workspace, tab.id) !==
            getCachedTerminalTabForWorktree(next.tabsByWorktree, workspace, tab.id)
          ) {
            affected.add(tab.id)
          }
        }
      }
    }
  }
  for (const source of [
    'terminalLayoutsByTabId',
    'ptyIdsByTabId',
    'retainedAgentsByPaneKey',
    'paneForegroundAgentByPaneKey'
  ] as const) {
    const before = previous[source]
    const after = next[source]
    if (before === after) {
      continue
    }
    const hints = source === 'paneForegroundAgentByPaneKey' ? terminalFacts[source] : undefined
    for (const key of hints ?? new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[key] === after[key]) {
        continue
      }
      if (source === 'retainedAgentsByPaneKey' || source === 'paneForegroundAgentByPaneKey') {
        addPane(key)
      } else {
        affected.add(key)
      }
    }
  }
  for (const source of [
    'unifiedTabsByWorktree',
    'layoutByWorktree',
    'groupsByWorktree',
    'activeGroupIdByWorktree'
  ] as const) {
    if (previous[source] === next[source]) {
      continue
    }
    if (source === 'unifiedTabsByWorktree' && terminalFacts[source]) {
      for (const id of terminalFacts[source]) {
        affected.add(id)
      }
      continue
    }
    for (const workspace of new Set([
      ...Object.keys(previous[source]),
      ...Object.keys(next[source])
    ])) {
      if (previous[source][workspace] === next[source][workspace]) {
        continue
      }
      if (source === 'unifiedTabsByWorktree') {
        const before = new Set(previous[source][workspace] ?? [])
        const after = new Set(next[source][workspace] ?? [])
        for (const item of new Set([...before, ...after])) {
          if (item.contentType === 'terminal' && before.has(item) !== after.has(item)) {
            affected.add(item.entityId)
          }
        }
      } else {
        for (const tab of [
          ...(previous.tabsByWorktree[workspace] ?? []),
          ...(next.tabsByWorktree[workspace] ?? [])
        ]) {
          affected.add(tab.id)
        }
      }
    }
  }
  if (previous.settings?.tabAutoGenerateTitle !== next.settings?.tabAutoGenerateTitle) {
    for (const id of getTerminalTabOwners(next.tabsByWorktree).keys()) {
      affected.add(id)
    }
  }
  if (!haveSameTerminalRoutingInputs(previous, next)) {
    for (const workspace of Object.keys(next.tabsByWorktree)) {
      if (
        worktreeUsesRemoteConnection(previous, workspace) !==
        worktreeUsesRemoteConnection(next, workspace)
      ) {
        for (const tab of next.tabsByWorktree[workspace]) {
          affected.add(tab.id)
        }
      }
    }
  }
  return affected
}
