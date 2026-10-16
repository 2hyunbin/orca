import { useCallback, useRef, useState } from 'react'
import type { SkillInstallResult } from '../../../shared/skill-install-contract'
import { describeBundledSkillInstallResult } from '../../../shared/bundled-orca-skill-install-report'
import type { BundledOrcaSkillInstallRequest } from '../../../shared/bundled-orca-skill-install-contract'
import { installBundledOrcaSkillsOnRuntimeTarget } from '@/runtime/runtime-skills-client'
import { buildLegacyNpxSkillInstallCommand } from '@/lib/legacy-npx-skill-install-command'
import type { ProjectAgentSkillRuntime } from '@/lib/project-skill-runtime'
import { useActiveSkillDiscoveryRuntimeTarget } from './use-active-skill-discovery-runtime-target'
import { useMountedRef } from './useMountedRef'

export type BundledSkillInstallState =
  | { kind: 'idle' }
  | { kind: 'installing' }
  | { kind: 'failed'; message: string }
  // Delete with LegacySkillSetupTerminal once servers without the bundled installer age out.
  | { kind: 'legacy-terminal'; command: string; attempt: number }

const SUCCEEDED_STATUSES: ReadonlySet<SkillInstallResult['status']> = new Set([
  'installed',
  'updated',
  'unchanged'
])

function settledState(results: readonly SkillInstallResult[]): BundledSkillInstallState {
  const unsettled = results.filter((result) => !SUCCEEDED_STATUSES.has(result.status))
  return unsettled.length === 0
    ? { kind: 'idle' }
    : { kind: 'failed', message: unsettled.map(describeBundledSkillInstallResult).join('\n') }
}

function wslTarget(
  agentRuntime: ProjectAgentSkillRuntime | undefined
): Pick<BundledOrcaSkillInstallRequest, 'wsl'> {
  if (agentRuntime?.runtime !== 'wsl') {
    return {}
  }
  const distro = agentRuntime.wslDistro?.trim()
  return { wsl: distro ? { distro } : {} }
}

/**
 * Installs Orca's own skills where the agents run: this machine, its WSL distro, or the
 * focused Orca server. A server that predates the installer gets the old terminal flow.
 */
export function useBundledSkillInstall(options: {
  agentRuntime?: ProjectAgentSkillRuntime
  onFinished?: () => void
}): {
  state: BundledSkillInstallState
  ready: boolean
  /** Resolves to the settled state, or null when no install started. */
  install: (skillNames: readonly string[]) => Promise<BundledSkillInstallState | null>
} {
  const { agentRuntime, onFinished } = options
  const runtimeTarget = useActiveSkillDiscoveryRuntimeTarget()
  const [state, setState] = useState<BundledSkillInstallState>({ kind: 'idle' })
  const runningRef = useRef(false)
  const attemptRef = useRef(0)
  const mountedRef = useMountedRef()

  const install = useCallback(
    async (skillNames: readonly string[]): Promise<BundledSkillInstallState | null> => {
      if (!runtimeTarget || runningRef.current || skillNames.length === 0) {
        return null
      }
      runningRef.current = true
      setState({ kind: 'installing' })
      let next: BundledSkillInstallState
      try {
        const outcome = await installBundledOrcaSkillsOnRuntimeTarget(runtimeTarget, {
          names: [...skillNames],
          ...wslTarget(agentRuntime)
        })
        attemptRef.current += 1
        next =
          outcome.kind === 'unsupported'
            ? {
                kind: 'legacy-terminal',
                command: buildLegacyNpxSkillInstallCommand(skillNames),
                attempt: attemptRef.current
              }
            : settledState(outcome.results)
      } catch (error) {
        next = { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
      } finally {
        runningRef.current = false
      }
      if (mountedRef.current) {
        setState(next)
      }
      // Why also on failure: a partial run can still have placed some skills.
      if (next.kind !== 'legacy-terminal') {
        onFinished?.()
      }
      return next
    },
    [agentRuntime, mountedRef, onFinished, runtimeTarget]
  )

  return { state, ready: runtimeTarget !== null, install }
}
