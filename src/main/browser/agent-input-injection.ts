import type { WebContents } from 'electron'
import {
  assertRemoteCliPageAdmitted,
  isHeldRemoteCliInputRelease
} from './remote-cli-page-admission'
import { assertRemoteCliBrowserAccess } from '../runtime/desktop-browser-bridge/remote-cli-browser-scope'

// Why: Orca's guest shortcut and grab handlers act on keys the page receives, and an unhandled key
// can reach the app menu. Keys an agent injects must do neither (#20595), whichever path sends them.
const injectionDepth = new WeakMap<WebContents, number>()

export function isAgentInjectingInput(webContents: WebContents): boolean {
  return (injectionDepth.get(webContents) ?? 0) > 0
}

/** The CDP input event being delivered, so a revoked command can still release what it pressed. */
export type AgentInputEvent = { method: string; params: Record<string, unknown> }

/** Refuses agent input that a revoked SSH host's command sends, directly or through its helper. */
export function assertAgentInputAdmitted(webContents: WebContents, input?: AgentInputEvent): void {
  if (!input || !isHeldRemoteCliInputRelease(webContents.id, input.method, input.params)) {
    assertRemoteCliBrowserAccess(webContents.id)
  }
  assertRemoteCliPageAdmitted(webContents.id, input?.method, input?.params)
}

/** Marks input sent during `run` as the agent's: Orca shortcuts and app menu items ignore it. */
export async function withAgentInputInjection<T>(
  webContents: WebContents,
  run: () => Promise<T>,
  input?: AgentInputEvent
): Promise<T> {
  assertAgentInputAdmitted(webContents, input)
  const depth = injectionDepth.get(webContents) ?? 0
  injectionDepth.set(webContents, depth + 1)
  if (depth === 0) {
    webContents.setIgnoreMenuShortcuts(true)
  }
  try {
    return await run()
  } finally {
    const remaining = (injectionDepth.get(webContents) ?? 1) - 1
    if (remaining > 0) {
      injectionDepth.set(webContents, remaining)
    } else {
      injectionDepth.delete(webContents)
      if (!webContents.isDestroyed()) {
        webContents.setIgnoreMenuShortcuts(false)
      }
    }
  }
}
