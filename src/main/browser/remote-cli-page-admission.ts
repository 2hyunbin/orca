/**
 * The pages an SSH host's command is driving right now, each with the check that refuses its next
 * step once that host is revoked. Every page-affecting sink (guest CDP sends, native input events,
 * edit commands) consults it, so no queued or deferred step of a running command outlives the
 * revocation.
 */
import { runOutsideRemoteCliBrowserScope } from '../runtime/desktop-browser-bridge/remote-cli-browser-scope'

/** The CDP input event that lets go of something a command pressed. */
export type HeldInputRelease = { method: string; params: Record<string, unknown> }

type Admission = {
  admit: () => void
  /** What this command pressed and has not released, keyed by button, key or touch. */
  held: Map<string, HeldInputRelease>
}

const admissions = new Map<number, Admission>()

/**
 * Runs a host's command holding the page. If the host is revoked mid-press, the command's own
 * release is refused like every other step, so the desktop lets go of what it left held once the
 * command ends: from outside the host's scope, with routing probes no longer refused.
 */
export async function runWithRemoteCliPageAdmission<T>(
  webContentsId: number,
  admit: () => void,
  run: () => Promise<T>,
  releaseHeld?: (release: HeldInputRelease) => Promise<unknown>
): Promise<T> {
  const admission: Admission = { admit, held: new Map() }
  admissions.set(webContentsId, admission)
  try {
    return await run()
  } finally {
    if (admissions.get(webContentsId) === admission) {
      admissions.delete(webContentsId)
    }
    if (releaseHeld && admission.held.size > 0 && isRevoked(admit)) {
      await runOutsideRemoteCliBrowserScope(() => releaseAll(admission.held, releaseHeld))
    }
  }
}

/** Throws while a revoked host's command still holds this page; a no-op otherwise. */
export function assertRemoteCliPageAdmitted(webContentsId: number | undefined): void {
  if (webContentsId !== undefined) {
    admissions.get(webContentsId)?.admit()
  }
}

/** Records input that reached a page a host's command holds, so a revocation can release it. */
export function noteRemoteCliInput(
  webContentsId: number | undefined,
  method: string,
  params?: Record<string, unknown>
): void {
  const admission = webContentsId === undefined ? undefined : admissions.get(webContentsId)
  if (admission) {
    trackInput(admission, method, params)
  }
}

function isRevoked(admit: () => void): boolean {
  try {
    admit()
    return false
  } catch {
    return true
  }
}

async function releaseAll(
  held: Map<string, HeldInputRelease>,
  releaseHeld: (release: HeldInputRelease) => Promise<unknown>
): Promise<void> {
  for (const release of held.values()) {
    try {
      await releaseHeld(release)
    } catch {
      // Best effort: the page may be gone, and nothing else is waiting on this release.
    }
  }
}

function trackInput(
  admission: Admission,
  method: string | undefined,
  params: Record<string, unknown> | undefined
): void {
  const type = params?.type
  if (!params || typeof type !== 'string') {
    return
  }
  if (
    method === 'Input.dispatchMouseEvent' &&
    (type === 'mousePressed' || type === 'mouseReleased')
  ) {
    const id = `mouse:${String(params.button ?? 'left')}`
    if (type === 'mouseReleased') {
      admission.held.delete(id)
      return
    }
    // Why off the page: letting go there completes no click or drop the host had started.
    admission.held.set(id, {
      method,
      params: { type: 'mouseReleased', x: -1, y: -1, button: params.button ?? 'left', buttons: 0 }
    })
  } else if (
    method === 'Input.dispatchKeyEvent' &&
    ['keyDown', 'rawKeyDown', 'keyUp'].includes(type)
  ) {
    const id = `key:${String(params.code ?? params.key ?? '')}`
    if (type === 'keyUp') {
      admission.held.delete(id)
      return
    }
    const { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode } = params
    admission.held.set(id, {
      method,
      params: { type: 'keyUp', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode }
    })
  } else if (method === 'Input.dispatchTouchEvent' && type.startsWith('touch')) {
    if (type === 'touchStart') {
      // Why cancel: a cancelled touch completes no tap the host had started.
      admission.held.set('touch', { method, params: { type: 'touchCancel', touchPoints: [] } })
    } else if (type === 'touchEnd' || type === 'touchCancel') {
      admission.held.delete('touch')
    }
  }
}
