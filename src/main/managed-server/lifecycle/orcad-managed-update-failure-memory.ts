/**
 * Hosts whose orcad update to this app's build failed during this launch, SSH and WSL alike: the
 * update decision's `failedBefore` input. Session-only, so a restart retries once.
 */
export type OrcadUpdateFailureHost = { kind: 'ssh' | 'wsl'; id: string }

const failedThisLaunch = new Set<string>()

function key(host: OrcadUpdateFailureHost): string {
  return `${host.kind}:${host.id}`
}

export function recordOrcadUpdateFailedThisLaunch(host: OrcadUpdateFailureHost): void {
  failedThisLaunch.add(key(host))
}

export function orcadUpdateFailedThisLaunch(host: OrcadUpdateFailureHost): boolean {
  return failedThisLaunch.has(key(host))
}

export function clearOrcadUpdateFailedThisLaunch(host: OrcadUpdateFailureHost): void {
  failedThisLaunch.delete(key(host))
}

export function resetOrcadUpdateFailuresForTests(): void {
  failedThisLaunch.clear()
}
