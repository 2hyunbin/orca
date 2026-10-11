import type { HeadlessSeedMetadata } from '../../runtime-terminal-state-records'
import {
  applyRestoredTerminalTailSeed,
  buildRestoredTerminalTailSeed,
  restoredTerminalTailSeedAllowed
} from '../../terminal-tail-restore-seed'
import type { RuntimeTerminalOutputOwner } from './terminal-output-owner'

export function seedHeadlessTerminal(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  data: string,
  size?: { cols: number; rows: number },
  metadata: HeadlessSeedMetadata = {}
): void {
  if (!data) {
    return
  }
  const existing = output.headlessTerminals.get(ptyId)
  if (existing) {
    // Why: emulator already has live data — re-seeding would duplicate
    // every byte. The seed is only valid when the emulator is fresh.
    if (metadata.preferProviderIfExisting) {
      output.providerSnapshotPreferredPtys.add(ptyId)
    }
    return
  }
  const dims = size ?? output.host.getTerminalSize(ptyId) ?? { cols: 80, rows: 24 }
  const state = output.host.createPtyHeadlessTerminalState(ptyId, dims)
  state.outputSequence = output.host.getPtyOutputSequence(ptyId)
  output.headlessTerminals.set(ptyId, state)
  output.host.recordOsc7MetadataForPty(ptyId, data)
  output.host.recordRecentPtyOutputForPathProvenance(ptyId, data)
  state.writeChain = state.writeChain
    .then(async () => {
      if (output.headlessTerminals.get(ptyId) !== state) {
        return
      }
      // Why: seed writes never set forwardQueryReplies — the main-side
      // replay guard. A snapshot containing old queries must answer no one.
      await state.emulator.write(data)
      if (output.headlessTerminals.get(ptyId) !== state) {
        return
      }
      // Why AFTER the seed write: the snapshot payload cannot carry kitty
      // pushes (rehydrateSequences deliberately omits them), but ordering
      // behind it keeps the parse deterministic. Unflagged like the seed —
      // re-applying flags must answer no one.
      if (typeof metadata.kittyKeyboardFlags === 'number') {
        await state.emulator.applyKittyKeyboardFlags(metadata.kittyKeyboardFlags)
        if (output.headlessTerminals.get(ptyId) !== state) {
          return
        }
      }
      if (metadata.cwd !== undefined) {
        state.emulator.setCwd(metadata.cwd)
      }
      if (metadata.oscLinks !== undefined) {
        state.emulator.setRestoredOscLinks(metadata.oscLinks)
      }
      // Why derived from the emulator: the seed bytes bypass ownership.scan,
      // so the scanner must inherit the restored alternate-screen state or a
      // pane seeded mid-TUI never arms its recovery trigger.
      state.ownership.seedOwner(metadata.terminalOwner, {
        alternateScreen: state.emulator.isAlternateScreen
      })
      output.providerSnapshotPreferredPtys.delete(ptyId)
    })
    .catch(() => {
      // Seeding is best-effort; live data will continue to populate the
      // emulator even if the snapshot replay fails.
    })
}

export function seedTerminalRestoreTail(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  restore: { text?: string; lastTitle?: string }
): void {
  const seed = restore.text ? buildRestoredTerminalTailSeed(restore.text) : null
  if (seed) {
    const pty = output.host.getOrCreatePtyWorktreeRecord(ptyId)
    // Why: live bytes outrank the seed — only never-written records take it,
    // so a same-run remount reattach cannot re-apply history it already has.
    if (pty && restoredTerminalTailSeedAllowed(pty)) {
      applyRestoredTerminalTailSeed(pty, seed)
      output.host.primeWaitBlockedBaselineFromSeededTail(ptyId)
    }
    for (const leaf of output.host.getLeavesForPty(ptyId)) {
      if (restoredTerminalTailSeedAllowed(leaf)) {
        applyRestoredTerminalTailSeed(leaf, seed)
      }
    }
  }
  if (restore.lastTitle) {
    // Why: mirror renderer hydration — a title main already tracked live outranks the payload's persisted one.
    output.host.applySeededAgentStatus(
      ptyId,
      output.host.getTrackedRawTitleForPty(ptyId) ?? restore.lastTitle
    )
  }
}
