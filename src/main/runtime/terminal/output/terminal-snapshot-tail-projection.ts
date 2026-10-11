import type { RuntimeTerminalRead } from '../../../../shared/runtime-types'
import type { RuntimeProviderSnapshotReadOptions } from '../../runtime-terminal-contracts'
import {
  buildVisibleSnapshotReadFallback,
  shouldFallbackToVisibleTerminalSnapshot,
  terminalReadLimit
} from '../../terminal-tail-read'
import type { RuntimeTerminalProjection } from '../../orca-runtime-core'
import { DEFAULT_TERMINAL_READ_LIMIT } from '../../terminal-tail-limits'
import { HeadlessEmulator } from '../../../daemon/headless-emulator'
import {
  projectTerminalTailLines,
  projectTerminalVisibleLines
} from '../../orca-runtime-terminal-projection'

import { VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS } from '../../orca-runtime-postlude'

import { withTimeout } from '../../runtime-async-boundaries'
import type { RuntimeTerminalOutputOwner } from './terminal-output-owner'

export async function withVisibleSnapshotFallback(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  read: RuntimeTerminalRead,
  opts: { cursor?: number; limit?: number } = {},
  providerSnapshot: RuntimeProviderSnapshotReadOptions = {}
): Promise<RuntimeTerminalRead> {
  if (typeof opts.cursor === 'number') {
    return read
  }
  const blankFallback = shouldFallbackToVisibleTerminalSnapshot(read, opts)
  const recoveredWorkerFallback =
    read.tail.length === 0 && output.host.legacyWorkerRecovery.hasRecoveredPty(ptyId)
  // Why: a live daemon session no pane ever attached has ingested zero bytes,
  // so only the provider holds its screen. Unprovable state stays empty.
  const neverAttachedProviderFallback =
    read.tail.length === 0 &&
    !recoveredWorkerFallback &&
    output.host.isKnownUnattachedLocalDaemonPty(ptyId)
  if (recoveredWorkerFallback || neverAttachedProviderFallback) {
    const providerProjection = await output.host.readProviderTerminalTailLines(
      ptyId,
      opts.limit,
      providerSnapshot
    )
    if (providerProjection.lines.length > 0) {
      return buildVisibleSnapshotReadFallback(
        read,
        providerProjection.lines,
        opts.limit,
        providerProjection.draft
      )
    }
  }
  const knownAlternateScreen = output.host.isTerminalAlternateScreen(ptyId)
  const providerModeUnknown =
    output.providerSnapshotPreferredPtys.has(ptyId) &&
    !output.providerModeTrackersByPtyId.has(ptyId)
  if (
    !blankFallback &&
    !recoveredWorkerFallback &&
    !providerModeUnknown &&
    !knownAlternateScreen &&
    !output.headlessTerminals.has(ptyId)
  ) {
    return read
  }
  const visibleState = await output.host.readVisibleTerminalState(ptyId)
  if (
    !blankFallback &&
    !recoveredWorkerFallback &&
    !knownAlternateScreen &&
    !visibleState?.isAlternateScreen
  ) {
    return read
  }
  let projection: RuntimeTerminalProjection = visibleState ?? { lines: [] }
  if (projection.lines.length === 0) {
    projection = await output.host.readRendererVisibleSnapshotLines(ptyId)
  }
  if (projection.lines.length === 0) {
    return read
  }
  return buildVisibleSnapshotReadFallback(read, projection.lines, opts.limit, projection.draft)
}

export async function readProviderTerminalTailLines(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  limit: number | undefined,
  snapshotOptions: RuntimeProviderSnapshotReadOptions = {}
): Promise<RuntimeTerminalProjection> {
  const generation = output.host.getPtyLifecycleGeneration(ptyId)
  const lineLimit = terminalReadLimit(limit, DEFAULT_TERMINAL_READ_LIMIT)
  const snapshot = await output.host.serializeProviderTerminalBuffer(
    ptyId,
    { scrollbackRows: snapshotOptions.visibleScreenOnly ? 0 : lineLimit },
    snapshotOptions
  )
  if (!snapshot) {
    return { lines: [] }
  }
  // Why: a cached acquisition can carry scrollback this caller did not ask for,
  // so visible-only reads parse the grid itself rather than trusting the request.
  if (snapshotOptions.visibleScreenOnly) {
    const projection = await output.host.parseVisibleSnapshot(snapshot)
    // Live bytes ordered after the provider frame make that frame stale.
    return output.ptyLifecycleGenerationById.get(ptyId) === generation &&
      output.host.getPtyOutputSequence(ptyId) <= snapshot.seq
      ? projection
      : { lines: [] }
  }
  const data = `${snapshot.scrollbackAnsi ?? ''}${snapshot.data}`
  if (data.length === 0) {
    return { lines: [] }
  }
  const emulator = new HeadlessEmulator({
    cols: snapshot.cols,
    rows: snapshot.rows,
    scrollback: lineLimit
  })
  try {
    await emulator.write(data)
    const projection = projectTerminalTailLines(emulator, lineLimit)
    return output.ptyLifecycleGenerationById.get(ptyId) === generation &&
      output.host.getPtyOutputSequence(ptyId) <= snapshot.seq
      ? projection
      : { lines: [] }
  } finally {
    emulator.dispose()
  }
}

export async function parseVisibleSnapshot(snapshot: {
  data: string
  cols: number
  rows: number
}): Promise<RuntimeTerminalProjection> {
  if (snapshot.data.length === 0) {
    return { lines: [] }
  }
  const emulator = new HeadlessEmulator({
    cols: snapshot.cols,
    rows: snapshot.rows,
    scrollback: 0
  })
  try {
    await emulator.write(`\x1b[2J\x1b[3J\x1b[H${snapshot.data}`)
    return projectTerminalVisibleLines(emulator)
  } finally {
    emulator.dispose()
  }
}

export async function readRendererVisibleSnapshotLines(
  output: RuntimeTerminalOutputOwner,
  ptyId: string
): Promise<RuntimeTerminalProjection> {
  const controller = output.host.ptyController
  if (!controller?.serializeBuffer) {
    return { lines: [] }
  }
  if (controller.hasRendererSerializer && !controller.hasRendererSerializer(ptyId)) {
    return { lines: [] }
  }
  try {
    // Why: raw PTY tails can be whitespace-only while a full-screen TUI is
    // visibly nonblank in renderer xterm. Ask the renderer for the active
    // screen instead of reusing the headless transcript path.
    const snapshot = await withTimeout(
      controller.serializeBuffer(ptyId, { scrollbackRows: 0 }),
      VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
      null
    )
    if (!snapshot || snapshot.data.length === 0) {
      return { lines: [] }
    }
    return output.host.parseVisibleSnapshot(snapshot)
  } catch {
    return { lines: [] }
  }
}
