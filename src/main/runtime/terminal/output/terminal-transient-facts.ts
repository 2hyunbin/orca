import type { RuntimePtyTitleTrackerEntry } from '../../runtime-terminal-state-records'

import type { PtyTransientFact } from '../../../providers/types'
import type {
  TerminalSideEffectBatch,
  TerminalSideEffectFact
} from '../../../../shared/terminal-side-effect-facts'

import type { RuntimeTerminalOutputOwner } from './terminal-output-owner'

export function flushPendingTerminalSideEffectFacts(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  entry: RuntimePtyTitleTrackerEntry
): void {
  if (entry.pendingFacts.length > 0) {
    const facts = entry.pendingFacts
    entry.pendingFacts = []
    output.host.emitTerminalSideEffectBatch(ptyId, facts)
  }
  const afterFacts = entry.afterFacts
  entry.afterFacts = []
  for (const run of afterFacts) {
    run()
  }
}

export function runAfterPendingTerminalSideEffectFacts(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  run: () => void
): void {
  const entry = output.ptyTitleTrackersByPtyId.get(ptyId)
  if (entry?.applyingChunk) {
    entry.afterFacts.push(run)
    return
  }
  run()
}

export function ingestSyntheticTitleFrame(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  data: string
): void {
  const entry = output.host.getOrCreatePtyTitleTrackerEntry(ptyId)
  entry.applyingChunk = true
  entry.chunkTouchedSessionTabs = false
  try {
    entry.tracker.applySyntheticTitleFrame(data)
  } finally {
    entry.applyingChunk = false
    output.host.flushPendingTerminalSideEffectFacts(ptyId, entry)
  }
  if (entry.chunkTouchedSessionTabs) {
    output.host.touchMobileSessionSnapshotsForPty(ptyId)
  }
}

export function setPtyTransientFactDelegation(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  delegated: boolean,
  scanSeedAnsi?: string,
  mode2031PendingSubscribe?: true
): void {
  const entry = output.host.getOrCreatePtyTitleTrackerEntry(ptyId)
  entry.tracker.setTransientFactScanningSuppressed(delegated)
  if (!delegated && scanSeedAnsi) {
    // Prime the freshly reset scanner carry with the emulator's dangling
    // incomplete escape at the handoff position — a sequence split across
    // the un-background toggle must not mint a phantom bell or lose its
    // fact. titleScanData:'' keeps titles out (they were never suppressed).
    entry.tracker.handleChunk(scanSeedAnsi, {
      titleScanData: '',
      mode2031PendingSubscribe
    })
  }
}

export function emitDaemonPtyTransientFact(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  fact: PtyTransientFact
): void {
  switch (fact.kind) {
    case 'bell':
      output.host.recordTerminalSideEffectFact(ptyId, { kind: 'bell' })
      return
    case 'command-finished':
      output.host.retirePtyAgentLaunchAuthority(ptyId)
      output.host.recordTerminalSideEffectFact(ptyId, {
        kind: 'command-finished',
        exitCode: fact.exitCode
      })
      output.host.openCodeRunLifetime.onCommandFinished(ptyId, fact.exitCode)
      return
    case 'pr-link':
      output.host.recordTerminalSideEffectFact(ptyId, { kind: 'pr-link', link: fact.link })
      return
    case '2031-subscribe':
      output.host.recordTerminalSideEffectFact(ptyId, { kind: '2031-subscribe' })
      return
    case '2031-unsubscribe':
      output.host.recordTerminalSideEffectFact(ptyId, { kind: '2031-unsubscribe' })
  }
}

export function notePtyDataGap(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  droppedChars = 0
): void {
  if (droppedChars > 0) {
    // Why: the daemon snapshot's seq counts bytes its monitoring stream
    // dropped. Advancing without parsing preserves that absolute domain so
    // post-snapshot live chunks can be reconciled instead of duplicated.
    const outputSequence = (output.ptyOutputSequenceById.get(ptyId) ?? 0) + droppedChars
    output.ptyOutputSequenceById.set(ptyId, outputSequence)
  }
  const pty = output.host.getOrCreatePtyWorktreeRecord(ptyId)
  if (pty) {
    pty.tailPendingAnsi = ''
    pty.commandPaint = undefined
  }
  for (const leaf of output.host.getLeavesForPty(ptyId)) {
    leaf.tailPendingAnsi = ''
  }
  output.oscTitleScanTailByPtyId.delete(ptyId)
  output.osc7ScanTailByPtyId.delete(ptyId)
  output.agentStatusOscProcessorsByPtyId.delete(ptyId)
  output.host.disposeHeadlessTerminal(ptyId)
}

export function recordTerminalSideEffectFact(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  fact: TerminalSideEffectFact
): void {
  if (!output.terminalSideEffectConsumerAvailable) {
    return
  }
  const entry = output.ptyTitleTrackersByPtyId.get(ptyId)
  if (entry?.applyingChunk) {
    entry.pendingFacts.push(fact)
    return
  }
  output.host.emitTerminalSideEffectBatch(ptyId, [fact])
}

export function emitTerminalSideEffectBatch(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  facts: TerminalSideEffectFact[],
  options: { replay?: boolean } = {}
): void {
  if (!output.terminalSideEffectConsumerAvailable || facts.length === 0) {
    return
  }
  const batch: TerminalSideEffectBatch = {
    ptyId,
    seq: output.ptyOutputSequenceById.get(ptyId) ?? 0,
    facts,
    ...(options.replay ? { replay: true } : {}),
    ...output.host.resolveTerminalSideEffectAttribution(ptyId)
  }
  if (output.terminalSideEffectLocalConsumerAvailable) {
    try {
      output.host.invokeTerminalSideEffects(batch)
    } catch (err) {
      console.error('[runtime] terminal side-effect listener threw', { ptyId, err })
    }
  }
  if (output.host.countTerminalSideEffectConsumingClientEventListeners() > 0) {
    output.host.emitClientEvent({ type: 'terminalSideEffects', batch })
  }
}
