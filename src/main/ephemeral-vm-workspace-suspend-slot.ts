// Kept apart from the suspend itself, so the runtime reads it without loading VM support.
let workspaceVmSuspend: ((workspaceId: string) => Promise<void>) | null = null

/** Set where VM support registers; a host without it (headless serve) suspends nothing. */
export function setWorkspaceVmSuspend(suspend: (workspaceId: string) => Promise<void>): void {
  workspaceVmSuspend = suspend
}

export function getWorkspaceVmSuspend(): ((workspaceId: string) => Promise<void>) | null {
  return workspaceVmSuspend
}
