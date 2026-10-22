import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

/** The host whose Orca skills the Update dialog, badge and nudge plan and update. */
export type BundledSkillTarget =
  | { kind: 'local' }
  /** This Windows app's WSL distro, where the active project's (or the default) agents run. */
  | { kind: 'wsl'; distro: string }
  /** A paired server or SSH host; it plans its own disk. */
  | { kind: 'environment'; environmentId: string }

/** Keys runs and nudge dismissals, so one host's result never reads as another's. */
export function bundledSkillTargetKey(target: BundledSkillTarget): string {
  switch (target.kind) {
    case 'local':
      return 'local'
    case 'wsl':
      return `wsl:${target.distro}`
    case 'environment':
      return `runtime:${target.environmentId}`
  }
}

/**
 * Where the agents run, never the client by default: null while the owning runtime is
 * unknown or a WSL project still needs its distro repaired.
 */
export function resolveBundledSkillTarget(
  runtimeTarget: RuntimeClientTarget | null,
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
): BundledSkillTarget | null {
  if (!runtimeTarget) {
    return null
  }
  if (runtimeTarget.kind === 'environment') {
    return { kind: 'environment', environmentId: runtimeTarget.environmentId }
  }
  if (projectRuntime?.status === 'repair-required') {
    return null
  }
  return projectRuntime?.runtime.kind === 'wsl'
    ? { kind: 'wsl', distro: projectRuntime.runtime.distro }
    : { kind: 'local' }
}
