import type { TerminalSideEffectBatch } from '../../../../shared/terminal-side-effect-facts'
import {
  detectAgentStatusFromTitle,
  isCursorNativeAgentTitle,
  normalizeTerminalTitle
} from '../../../../shared/agent-detection'
import {
  getLeafDisplayRecord as projectLeafDisplayRecord,
  getPtyDisplayRecord as projectPtyDisplayRecord,
  type TitleDisplayClear
} from '../../runtime-worktree-status-projection'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'
import type { TerminalTitleFactMeta } from '../../../../shared/terminal-output-side-effects'

import { getDecorativeTitleGateKey } from '../../../../shared/agent-decorative-title-signature'

import type { RuntimeTerminalOutputOwner } from './terminal-output-owner'

export function resolveTerminalSideEffectAttribution(
  output: RuntimeTerminalOutputOwner,
  ptyId: string
): {
  worktreeId?: string
  tabId?: string
  paneKey?: string
  connectionId?: string | null
} {
  const pty = output.host.ptysById.get(ptyId)
  const connectionId = pty?.connectionId ?? null
  for (const leaf of output.host.getLeavesForPty(ptyId)) {
    return {
      worktreeId: leaf.worktreeId,
      tabId: leaf.tabId,
      paneKey: output.host.makeRuntimePaneKey(leaf),
      connectionId
    }
  }
  if (pty?.paneKey) {
    return {
      worktreeId: pty.worktreeId,
      ...(pty.tabId ? { tabId: pty.tabId } : {}),
      paneKey: pty.paneKey,
      connectionId
    }
  }
  return {}
}

export function getTerminalSideEffectSnapshot(
  output: RuntimeTerminalOutputOwner,
  ptyId: string
): TerminalSideEffectBatch | null {
  const tracker = output.ptyTitleTrackersByPtyId.get(ptyId)?.tracker
  const recordTitle = output.host.ptysById.get(ptyId)?.lastOscTitle
  const normalizedTitle = tracker?.getLastNormalizedTitle() ?? null
  // Why: a record-fallback snapshot must not replay the bare cursor-agent literal over a
  // tracker title Orca synthesized from hooks — but with no tracker title it is the pane's
  // only Cursor identity, so restored/mobile tabs keep it (#10258).
  const rawTitle =
    recordTitle && (normalizedTitle === null || !isCursorNativeAgentTitle(recordTitle))
      ? recordTitle
      : null
  if (normalizedTitle === null && !rawTitle) {
    return null
  }
  return {
    ptyId,
    seq: output.ptyOutputSequenceById.get(ptyId) ?? 0,
    replay: true,
    facts: [
      {
        kind: 'title',
        normalizedTitle: normalizedTitle ?? normalizeTerminalTitle(rawTitle!),
        rawTitle: rawTitle ?? normalizedTitle!
      }
    ],
    ...output.host.resolveTerminalSideEffectAttribution(ptyId)
  }
}

export function getTrackedRawTitleForPty(
  output: RuntimeTerminalOutputOwner,
  ptyId: string
): string | null {
  const recordTitle = output.host.ptysById.get(ptyId)?.lastOscTitle
  if (recordTitle) {
    return recordTitle
  }
  for (const leaf of output.host.getLeavesForPty(ptyId)) {
    if (leaf.lastOscTitle) {
      return leaf.lastOscTitle
    }
  }
  return null
}

export function isLiveCursorNativeTitle(rawTitle: string, meta?: TerminalTitleFactMeta): boolean {
  return isCursorNativeAgentTitle(rawTitle) && meta?.staleWorkingTitleClear !== true
}

export function getTrackedDisplayTitleForPty(
  output: RuntimeTerminalOutputOwner,
  ptyId: string
): string | null {
  return (
    output.host.getPtyTitleDisplayClear(ptyId)?.title ??
    output.host.getTrackedRawTitleForPty(ptyId) ??
    output.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.getLastNormalizedTitle() ??
    null
  )
}

export function getPtyTitleDisplayClear(
  output: RuntimeTerminalOutputOwner,
  ptyId: string | null | undefined
): TitleDisplayClear | null {
  const clear = ptyId ? output.host.ptysById.get(ptyId)?.titleDisplayClear : null
  return clear ? { ...clear, status: detectAgentStatusFromTitle(clear.title) } : null
}

export function getPtyDisplayRecord(
  output: RuntimeTerminalOutputOwner,
  pty: RuntimePtyWorktreeRecord
): RuntimePtyWorktreeRecord {
  return projectPtyDisplayRecord(pty, output.host.getPtyTitleDisplayClear(pty.ptyId))
}

export function getLeafDisplayRecord(
  output: RuntimeTerminalOutputOwner,
  leaf: RuntimeLeafRecord
): RuntimeLeafRecord {
  return projectLeafDisplayRecord(leaf, output.host.getPtyTitleDisplayClear(leaf.ptyId))
}

export function getUnpersistedTrackedTitleForPty(
  output: RuntimeTerminalOutputOwner,
  ptyId: string | null
): string | null {
  if (!ptyId || output.host.getTrackedRawTitleForPty(ptyId) !== null) {
    return null
  }
  // Why: a manual title is authoritative until explicitly cleared with null.
  const pty = output.host.ptysById.get(ptyId)
  if (pty && pty.title !== null) {
    return null
  }
  return output.ptyTitleTrackersByPtyId.get(ptyId)?.tracker.getLastNormalizedTitle() ?? null
}

export function preferTrackedLastTitle<T extends { lastTitle?: string }>(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  snapshot: T
): T {
  const tracked = output.host.getTrackedDisplayTitleForPty(ptyId)
  if (!tracked) {
    return snapshot
  }
  return { ...snapshot, lastTitle: tracked }
}

export function makeDecorativeTitleGateKey(rawTitle: string, normalizedTitle: string): string {
  return getDecorativeTitleGateKey(rawTitle, normalizedTitle)
}
