/**
 * Which panes main's legacy relay bridge serves, known before those panes mount.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15, with src/main/ssh/legacy-relay-bridge/.
 */
import type { LegacyRelayBridgedPane } from '../../../../shared/legacy-relay-bridge-contract'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  toHostSessionTabId
} from '../../../../shared/terminal-surface-id'

let panes: LegacyRelayBridgedPane[] = []
const listeners = new Set<() => void>()
let subscribed = false

function ensureSubscribed(): void {
  const api = typeof window === 'undefined' ? undefined : window.api?.legacyRelayBridge
  if (subscribed || !api) {
    return
  }
  subscribed = true
  const apply = (next: LegacyRelayBridgedPane[]): void => {
    panes = Array.isArray(next) ? next : []
    listeners.forEach((listener) => listener())
  }
  api.onPanes(apply)
  void api.listPanes().then(apply, () => {})
}

ensureSubscribed()

export function legacyRelayBridgedPane(ptyId: string): LegacyRelayBridgedPane | undefined {
  ensureSubscribed()
  return panes.find((pane) => pane.ptyId === ptyId)
}

/**
 * The relay-era PTY a runtime pane should reattach through the bridge: one main reports serving
 * for this tab and leaf, or the `ssh:` id the pane itself still names from an earlier bridging.
 */
export function legacyRelayBridgePtyIdForPane(args: {
  tabId: string
  leafId: string | null | undefined
  boundPtyId: string | null | undefined
}): string | null {
  ensureSubscribed()
  if (!window.api?.legacyRelayBridge) {
    return null
  }
  // A tab mirrored from the managed server is `web-terminal-<tab::leaf>`; the lease names the
  // relay-era tab and leaf it carried over.
  const [hostTabId, hostLeafId] = toHostSessionTabId(args.tabId).split(
    HOST_TERMINAL_SURFACE_SEPARATOR
  )
  const served = panes.find(
    (pane) =>
      pane.tabId === hostTabId &&
      (!pane.leafId || pane.leafId === (hostLeafId ?? args.leafId) || pane.leafId === args.leafId)
  )
  if (served) {
    return served.ptyId
  }
  return args.boundPtyId && parseAppSshPtyId(args.boundPtyId) ? args.boundPtyId : null
}

export function onLegacyRelayBridgedPanesChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
