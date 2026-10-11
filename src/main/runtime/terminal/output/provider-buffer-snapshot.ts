import type { PtyProviderBufferSnapshot } from '../../../providers/types'
import { withTimeout } from '../../runtime-async-boundaries'

import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'

import type { RuntimeTerminalOutputOwner } from './terminal-output-owner'

export async function serializeProviderTerminalBuffer(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  opts: { scrollbackRows?: number } = {},
  wait: { timeoutMs?: number; retireOnTimeout?: boolean } = {}
): Promise<PtyProviderBufferSnapshot | null> {
  const generation = output.host.getPtyLifecycleGeneration(ptyId)
  const scrollbackRows = Math.max(0, Math.floor(opts.scrollbackRows ?? 0))
  let acquisition = output.providerBufferAcquisitionsByPtyId.get(ptyId)
  if (acquisition?.generation === generation && acquisition.timedOut) {
    return null
  }
  if (
    !acquisition ||
    acquisition.generation !== generation ||
    acquisition.scrollbackRows < scrollbackRows
  ) {
    const promise = output.host.captureProviderTerminalBuffer(ptyId, opts, generation)
    acquisition = { generation, scrollbackRows, promise, timedOut: false }
    output.providerBufferAcquisitionsByPtyId.set(ptyId, acquisition)
    void promise.finally(() => {
      if (output.providerBufferAcquisitionsByPtyId.get(ptyId) === acquisition) {
        output.providerBufferAcquisitionsByPtyId.delete(ptyId)
      }
    })
  }
  if (acquisition.timedOut) {
    return null
  }
  if (typeof wait.timeoutMs !== 'number') {
    return acquisition.promise
  }
  const result = await withTimeout<
    { settled: true; value: PtyProviderBufferSnapshot | null } | { settled: false }
  >(
    acquisition.promise.then((value) => ({ settled: true as const, value })),
    wait.timeoutMs,
    { settled: false as const }
  )
  if (!result.settled) {
    if (wait.retireOnTimeout) {
      acquisition.timedOut = true
    }
    return null
  }
  return result.value
}

export async function captureProviderTerminalBuffer(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  opts: { scrollbackRows?: number },
  generation: number
): Promise<PtyProviderBufferSnapshot | null> {
  const liveModeTracker = new TerminalKittyKeyboardModeTracker()
  let liveModeTrackers = output.providerModeSnapshotScansByPtyId.get(ptyId)
  if (!liveModeTrackers) {
    liveModeTrackers = new Set()
    output.providerModeSnapshotScansByPtyId.set(ptyId, liveModeTrackers)
  }
  liveModeTrackers.add(liveModeTracker)
  try {
    // Why: daemon PTYs survive an app relaunch before any renderer mounts.
    // Mobile still needs their retained history without navigating desktop.
    const snapshot = await output.host.ptyController?.serializeProviderBuffer?.(ptyId, opts)
    if (!snapshot || output.ptyLifecycleGenerationById.get(ptyId) !== generation) {
      return null
    }
    const snapshotModeTracker = new TerminalKittyKeyboardModeTracker()
    if (typeof snapshot.alternateScreen === 'boolean') {
      snapshotModeTracker.scan(snapshot.alternateScreen ? '\x1b[?1049h' : '\x1b[?1049l')
    } else {
      // Why: older providers omit mode metadata, but their ANSI snapshot
      // still carries the DECSET/DECRST needed to classify the active screen.
      snapshotModeTracker.scanReplay(snapshot.data)
    }
    const observedSnapshotMode = snapshotModeTracker.hasObservedAlternateScreenSwitch
    let effectiveAlternateScreen: boolean | undefined
    if (observedSnapshotMode || liveModeTracker.hasObservedAlternateScreenSwitch) {
      const modeTracker = new TerminalKittyKeyboardModeTracker()
      if (observedSnapshotMode) {
        modeTracker.scan(snapshotModeTracker.isAlternateScreen ? '\x1b[?1049h' : '\x1b[?1049l')
      }
      // Why: stream bytes received after the request began can be newer
      // than snapshot metadata, so an observed live transition wins.
      if (liveModeTracker.hasObservedAlternateScreenSwitch) {
        modeTracker.scan(liveModeTracker.isAlternateScreen ? '\x1b[?1049h' : '\x1b[?1049l')
      }
      output.providerModeTrackersByPtyId.set(ptyId, modeTracker)
      effectiveAlternateScreen = modeTracker.isAlternateScreen
    }
    const providerOffset = output.providerSequenceOffsetByPtyId.get(ptyId) ?? 0
    const reconciledSnapshot = output.host.preferTrackedLastTitle(ptyId, {
      ...snapshot,
      seq: providerOffset + snapshot.seq,
      ...(effectiveAlternateScreen !== undefined
        ? { alternateScreen: effectiveAlternateScreen }
        : {})
    })
    if (liveModeTracker.hasObservedAlternateScreenSwitch) {
      output.providerSnapshotsWithLiveModeTransition.add(reconciledSnapshot)
    }
    return reconciledSnapshot
  } catch {
    return null
  } finally {
    liveModeTrackers.delete(liveModeTracker)
    if (
      liveModeTrackers.size === 0 &&
      output.providerModeSnapshotScansByPtyId.get(ptyId) === liveModeTrackers
    ) {
      output.providerModeSnapshotScansByPtyId.delete(ptyId)
    }
  }
}
