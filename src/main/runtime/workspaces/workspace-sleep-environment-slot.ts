import type { WorkspaceSleepDeps } from './workspace-sleep-execution'

export type WorkspaceSleepEnvironments = Pick<
  WorkspaceSleepDeps,
  'callEnvironment' | 'environmentMarksSleep'
>

// Set by the desktop's paired-server support; a headless serve has no paired servers.
let environments: WorkspaceSleepEnvironments | null = null

export function setWorkspaceSleepEnvironments(next: WorkspaceSleepEnvironments): void {
  environments = next
}

export function getWorkspaceSleepEnvironments(): WorkspaceSleepEnvironments | null {
  return environments
}
