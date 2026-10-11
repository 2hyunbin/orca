import type { RuntimeTerminalProjection } from '../../orca-runtime-core'
import { buildPreview } from '../../terminal-tail-state'
import type {
  RuntimeHeadlessTerminal,
  RuntimeVisibleTerminalState
} from '../../runtime-terminal-state-records'
import {
  VISIBLE_TERMINAL_SNAPSHOT_RETRY_MS,
  VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS
} from '../../orca-runtime-postlude'
import { projectTerminalVisibleLines } from '../../orca-runtime-terminal-projection'
import { visibleNonBlankTerminalLines } from '../../terminal-tail-read'
import type { RuledScreen } from '../../screen-input-veto'

import type { RuntimeTerminalOutputOwner } from './terminal-output-owner'

export async function visibleSnapshotPreview(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  preview: string
): Promise<string> {
  const knownAlternateScreen = output.host.isTerminalAlternateScreen(ptyId)
  const providerModeUnknown =
    output.providerSnapshotPreferredPtys.has(ptyId) &&
    !output.providerModeTrackersByPtyId.has(ptyId)
  if (!providerModeUnknown && !knownAlternateScreen && !output.headlessTerminals.has(ptyId)) {
    return preview
  }
  const visibleState = await output.host.readVisibleTerminalState(ptyId)
  if (!knownAlternateScreen && !visibleState?.isAlternateScreen) {
    return preview
  }
  let projection: RuntimeTerminalProjection = visibleState ?? { lines: [] }
  if (projection.lines.length === 0) {
    projection = await output.host.readRendererVisibleSnapshotLines(ptyId)
  }
  return projection.lines.length > 0 ? buildPreview(projection.lines, '') : preview
}

export async function readVisibleTerminalState(
  output: RuntimeTerminalOutputOwner,
  ptyId: string
): Promise<RuntimeVisibleTerminalState | null> {
  const generation = output.host.getPtyLifecycleGeneration(ptyId)
  const pending = output.providerVisibleStateReadsByPtyId.get(ptyId)
  if (pending?.generation === generation) {
    return pending.promise
  }
  let entry: { generation: number; promise: Promise<RuntimeVisibleTerminalState | null> }
  const promise = output.host.loadVisibleTerminalState(ptyId).finally(() => {
    if (output.providerVisibleStateReadsByPtyId.get(ptyId) === entry) {
      output.providerVisibleStateReadsByPtyId.delete(ptyId)
    }
  })
  entry = { generation, promise }
  output.providerVisibleStateReadsByPtyId.set(ptyId, entry)
  return promise
}

export async function loadVisibleTerminalState(
  output: RuntimeTerminalOutputOwner,
  ptyId: string
): Promise<RuntimeVisibleTerminalState | null> {
  if (!output.providerSnapshotPreferredPtys.has(ptyId)) {
    return output.host.readHeadlessVisibleTerminalState(ptyId)
  }

  const generation = output.host.getPtyLifecycleGeneration(ptyId)
  const outputSequence = output.host.getPtyOutputSequence(ptyId)
  const cached = output.providerVisibleStateByPtyId.get(ptyId)
  const trackedMode = output.providerModeTrackersByPtyId.get(ptyId)
  if (
    cached?.generation === generation &&
    outputSequence <= cached.sequence &&
    (!trackedMode || trackedMode.isAlternateScreen === cached.isAlternateScreen)
  ) {
    return cached
  }
  if (trackedMode && !trackedMode.isAlternateScreen) {
    const headlessState = await output.host.readHeadlessVisibleTerminalState(ptyId)
    return headlessState
      ? { ...headlessState, isAlternateScreen: false }
      : {
          lines: [],
          isAlternateScreen: false,
          sequence: outputSequence,
          generation
        }
  }
  if ((output.providerVisibleRetryAtByPtyId.get(ptyId) ?? 0) > Date.now()) {
    return null
  }

  const snapshot = await output.host.serializeProviderTerminalBuffer(
    ptyId,
    { scrollbackRows: 0 },
    { timeoutMs: VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS }
  )
  if (!snapshot || output.host.getPtyLifecycleGeneration(ptyId) !== generation) {
    output.providerVisibleRetryAtByPtyId.set(ptyId, Date.now() + VISIBLE_TERMINAL_SNAPSHOT_RETRY_MS)
    return null
  }
  output.providerVisibleRetryAtByPtyId.delete(ptyId)
  if (output.providerSnapshotsWithLiveModeTransition.has(snapshot)) {
    // Why: the provider frame can predate a mode switch observed while its
    // RPC was pending; the ordered live emulator owns the post-switch grid.
    const liveState = await output.host.readHeadlessVisibleTerminalState(ptyId)
    if (liveState && liveState.isAlternateScreen === (snapshot.alternateScreen ?? false)) {
      return liveState
    }
  }
  const projection = await output.host.parseVisibleSnapshot(snapshot)
  if (
    output.host.getPtyLifecycleGeneration(ptyId) !== generation ||
    output.host.getPtyOutputSequence(ptyId) > snapshot.seq
  ) {
    return null
  }
  const visibleState: RuntimeVisibleTerminalState = {
    ...projection,
    isAlternateScreen: snapshot.alternateScreen ?? false,
    sequence: snapshot.seq,
    generation
  }
  output.providerVisibleStateByPtyId.set(ptyId, visibleState)
  return visibleState
}

export async function readHeadlessVisibleTerminalState(
  output: RuntimeTerminalOutputOwner,
  ptyId: string
): Promise<RuntimeVisibleTerminalState | null> {
  const state = output.headlessTerminals.get(ptyId)
  if (!state) {
    return null
  }
  const generation = output.host.getPtyLifecycleGeneration(ptyId)
  await state.writeChain
  if (
    output.headlessTerminals.get(ptyId) !== state ||
    output.host.getPtyLifecycleGeneration(ptyId) !== generation
  ) {
    return null
  }
  return {
    ...projectTerminalVisibleLines(state.emulator),
    isAlternateScreen: state.emulator.isAlternateScreen,
    sequence: state.outputSequence,
    generation
  }
}

export function readLiveTerminalScreenLines(
  output: RuntimeTerminalOutputOwner,
  ptyId: string | null | undefined
): string[] | null {
  const state = output.host.readWholeScreenModel(ptyId)
  // Why unawaited writeChain: callers are synchronous; a grid one chunk behind is re-read next poll.
  return state ? projectTerminalVisibleLines(state.emulator).lines : null
}

export function readRuledScreen(
  output: RuntimeTerminalOutputOwner,
  ptyId: string | null | undefined
): RuledScreen | null {
  const state = output.host.readWholeScreenModel(ptyId)
  if (!ptyId || !state || state.unrepaintedReflowGrid !== undefined) {
    return null
  }
  // Why: a TUI painted for another grid garbles on this one, and a screen rule would refuse it.
  const ptySize = output.host.getTerminalSize(ptyId)
  const grid = state.emulator.getAppliedSize()
  if (!ptySize || ptySize.cols !== grid.cols || ptySize.rows !== grid.rows) {
    return null
  }
  // Why raw rows, not the read projection: it blanks a composer it takes for a draft, and Cline's
  // placeholder reads as one, so a typed draft and an empty composer would look the same.
  return {
    lines: visibleNonBlankTerminalLines(state.emulator.getVisibleLines()),
    alternateScreen: state.emulator.isAlternateScreen
  }
}

export function readWholeScreenModel(
  output: RuntimeTerminalOutputOwner,
  ptyId: string | null | undefined
): RuntimeHeadlessTerminal | null {
  if (!ptyId) {
    return null
  }
  const state = output.headlessTerminals.get(ptyId)
  if (
    !state ||
    output.providerSnapshotPreferredPtys.has(ptyId) ||
    output.headlessHydrationState.get(ptyId) === 'pending'
  ) {
    return null
  }
  return state
}
