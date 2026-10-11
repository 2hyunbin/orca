import type { TerminalOscLinkRange } from '../../../../shared/terminal-osc-link-ranges'

import type { RuntimeTerminalOutputOwner } from './terminal-output-owner'

export function serializeMainTerminalBuffer(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  opts: { scrollbackRows?: number } = {}
): Promise<{
  data: string
  frameRestoreAnsi?: string
  cols: number
  rows: number
  seq?: number
  cwd?: string | null
  lastTitle?: string
  source?: 'headless' | 'renderer'
  oscLinks?: TerminalOscLinkRange[]
  alternateScreen?: boolean
  scrollbackAnsi?: string
  pendingEscapeTailAnsi?: string
  terminalOwner?: 'shell'
} | null> {
  return output.host.serializeHeadlessTerminalBuffer(ptyId, { ...opts, includeEmpty: true })
}

export async function serializeHiddenOutputRecoveryBuffer(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  opts: { scrollbackRows?: number } = {}
): Promise<{
  data: string
  frameRestoreAnsi?: string
  cols: number
  rows: number
  cwd?: string | null
  lastTitle?: string
  seq?: number
  source?: 'headless' | 'renderer'
  oscLinks?: TerminalOscLinkRange[]
  alternateScreen?: boolean
  scrollbackAnsi?: string
  pendingEscapeTailAnsi?: string
  terminalOwner?: 'shell'
} | null> {
  const restoredSnapshot = await output.host.serializePreferredRestoredTerminalBuffer(ptyId, opts)
  if (restoredSnapshot) {
    return restoredSnapshot
  }
  const headlessSnapshot = await output.host.serializeHeadlessTerminalBuffer(ptyId, {
    ...opts,
    includeEmpty: true
  })
  if (headlessSnapshot) {
    return headlessSnapshot
  }
  // Why: hidden-output recovery is initiated by the desktop renderer. If the
  // runtime has not built headless state yet, the mounted xterm is still the
  // best available state and avoids a false "snapshot unavailable" result.
  const rendererSnapshot = await output.host.serializeRendererTerminalBuffer(ptyId, opts)
  return rendererSnapshot ?? output.host.serializeProviderTerminalBuffer(ptyId, opts)
}

export async function serializeTerminalBufferFromAvailableState(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  opts: { scrollbackRows?: number } = {}
): Promise<{
  data: string
  frameRestoreAnsi?: string
  cols: number
  rows: number
  cwd?: string | null
  lastTitle?: string
  seq?: number
  source?: 'headless' | 'renderer'
  oscLinks?: TerminalOscLinkRange[]
  alternateScreen?: boolean
  pendingEscapeTailAnsi?: string
  kittyKeyboardFlags?: number
  terminalOwner?: 'shell'
} | null> {
  const restoredSnapshot = await output.host.serializePreferredRestoredTerminalBuffer(ptyId, opts)
  if (restoredSnapshot) {
    return restoredSnapshot
  }
  const headlessSnapshot = await output.host.serializeHeadlessTerminalBuffer(ptyId, opts)
  if (headlessSnapshot) {
    return headlessSnapshot
  }

  const rendererSnapshot = await output.host.serializeRendererTerminalBuffer(ptyId, opts)
  if (!rendererSnapshot) {
    return output.host.serializeProviderTerminalBuffer(ptyId, opts)
  }
  if (rendererSnapshot.data.length > 0) {
    return rendererSnapshot
  }
  // Why: parked desktop panes register serializers before their xterm has
  // hydrated. Treat that empty shell as provisional so retained provider
  // history can restore mobile without forcing the desktop pane to mount.
  const providerSnapshot = await output.host.serializeProviderTerminalBuffer(ptyId, opts)
  return providerSnapshot &&
    (providerSnapshot.data.length > 0 || Boolean(providerSnapshot.scrollbackAnsi))
    ? providerSnapshot
    : rendererSnapshot
}

export async function serializePreferredRestoredTerminalBuffer(
  output: RuntimeTerminalOutputOwner,
  ptyId: string,
  opts: { scrollbackRows?: number } = {}
) {
  if (!output.providerSnapshotPreferredPtys.has(ptyId)) {
    return null
  }
  // Pre-attach bytes are only a suffix; older providers can fall back to the renderer.
  return (
    (await output.host.serializeProviderTerminalBuffer(ptyId, opts)) ??
    (await output.host.serializeRendererTerminalBuffer(ptyId, opts))
  )
}
