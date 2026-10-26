/**
 * The user's own Add and Remove of a WSL host, as opposed to the move orchestrator's automatic
 * add: a Remove is the user declining the host, and only their Add (or Retry) takes that back.
 */
export type WslHostUserAction = { kind: 'added' | 'removed'; distro: string }

const listeners = new Set<(action: WslHostUserAction) => void>()

export function onWslHostUserAction(listener: (action: WslHostUserAction) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function noteWslHostUserAction(action: WslHostUserAction): void {
  for (const listener of listeners) {
    listener(action)
  }
}
