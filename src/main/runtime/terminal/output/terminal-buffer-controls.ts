import type { RuntimeTerminalOutputOwner } from './terminal-output-owner'

export async function clearTerminalBuffer(
  output: RuntimeTerminalOutputOwner,
  handle: string
): Promise<{ handle: string; cleared: boolean }> {
  const leaf = output.host.resolveLeafForHandle(handle)
  if (!leaf?.ptyId) {
    throw new Error('terminal_not_found')
  }
  // Why: clear is a terminal UI action (Cmd+K on desktop), not shell input.
  // Route through the controller so renderer-owned xterm buffers, daemon
  // sessions, and SSH relay sessions all drop scrollback before the next
  // mobile snapshot.
  await output.host.ptyController?.clearBuffer?.(leaf.ptyId)
  await output.host.clearHeadlessTerminalBuffer(leaf.ptyId)
  return { handle, cleared: true }
}

export async function resetTerminalInputModes(
  output: RuntimeTerminalOutputOwner,
  handle: string
): Promise<{ handle: string; reset: boolean }> {
  const leaf = output.host.resolveLeafForHandle(handle)
  if (!leaf?.ptyId) {
    throw new Error('terminal_not_found')
  }
  await output.host.ptyController?.resetInputModes?.(leaf.ptyId)
  await output.host.resetHeadlessTerminalInputModes(leaf.ptyId)
  return { handle, reset: true }
}

export function getTerminalSize(
  output: RuntimeTerminalOutputOwner,
  ptyId: string
): { cols: number; rows: number } | null {
  return output.host.ptyController?.getSize?.(ptyId) ?? null
}

export function isTerminalAlternateScreen(
  output: RuntimeTerminalOutputOwner,
  ptyId: string
): boolean {
  if (output.providerSnapshotPreferredPtys.has(ptyId)) {
    return output.providerModeTrackersByPtyId.get(ptyId)?.isAlternateScreen ?? false
  }
  return (
    output.headlessTerminals.get(ptyId)?.emulator.isAlternateScreen ??
    output.providerModeTrackersByPtyId.get(ptyId)?.isAlternateScreen ??
    false
  )
}
