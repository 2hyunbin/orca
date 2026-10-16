import { useCallback, useMemo, useRef, useState } from 'react'
import type { SkillInstallResult } from '../../../shared/skill-install-contract'
import { describeBundledSkillInstallResult } from '../../../shared/bundled-orca-skill-install-report'
import type { BundledOrcaSkillInstallRequest } from '../../../shared/bundled-orca-skill-install-contract'
import { installBundledOrcaSkillsOnRuntimeTarget } from '@/runtime/runtime-skills-client'
import { buildLegacyNpxSkillInstallCommand } from '@/lib/legacy-npx-skill-install-command'
import {
  bundledSkillInstallErrorMessage,
  bundledSkillInstallTargetPendingMessage
} from '@/lib/bundled-skill-install-error-message'
import type { ProjectAgentSkillRuntime } from '@/lib/project-skill-runtime'
import { useActiveSkillDiscoveryRuntimeTarget } from './use-active-skill-discovery-runtime-target'
import { useMountedRef } from './useMountedRef'

export type BundledSkillInstallState =
  | { kind: 'idle' }
  | { kind: 'installing' }
  | { kind: 'failed'; message: string }
  // Delete with the legacy terminal once servers without the bundled installer age out.
  | { kind: 'legacy-terminal'; command: string }

export type BundledSkillInstall = {
  state: BundledSkillInstallState
  ready: boolean
  /** Resolves to the settled state, or null when this target's install is already running. */
  install: (skillNames: readonly string[]) => Promise<BundledSkillInstallState | null>
  /** Reruns the last requested install. */
  retry: () => void
}

const IDLE: BundledSkillInstallState = { kind: 'idle' }

const SUCCEEDED_STATUSES: ReadonlySet<SkillInstallResult['status']> = new Set([
  'installed',
  'updated',
  'unchanged'
])

function settledState(results: readonly SkillInstallResult[]): BundledSkillInstallState {
  const unsettled = results.filter((result) => !SUCCEEDED_STATUSES.has(result.status))
  return unsettled.length === 0
    ? IDLE
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
}): BundledSkillInstall {
  const { agentRuntime, onFinished } = options
  const runtimeTarget = useActiveSkillDiscoveryRuntimeTarget()
  const wsl = useMemo(() => wslTarget(agentRuntime), [agentRuntime])
  // Why keyed: a result or failure belongs to the machine it ran on, not the one now focused.
  const targetKey = JSON.stringify([runtimeTarget, wsl])
  const [entry, setEntry] = useState<{ targetKey: string; state: BundledSkillInstallState }>({
    targetKey,
    state: IDLE
  })
  // Why per target: an install still running on the previous machine must not block this one.
  const runningTargetKeysRef = useRef(new Set<string>())
  const lastSkillNamesRef = useRef<readonly string[]>([])
  const mountedRef = useMountedRef()

  const install = useCallback(
    async (skillNames: readonly string[]): Promise<BundledSkillInstallState | null> => {
      if (skillNames.length === 0) {
        return null
      }
      if (runningTargetKeysRef.current.has(targetKey)) {
        setEntry({ targetKey, state: { kind: 'installing' } })
        return null
      }
      lastSkillNamesRef.current = skillNames
      if (!runtimeTarget) {
        const pending: BundledSkillInstallState = {
          kind: 'failed',
          message: bundledSkillInstallTargetPendingMessage()
        }
        setEntry({ targetKey, state: pending })
        return pending
      }
      runningTargetKeysRef.current.add(targetKey)
      setEntry({ targetKey, state: { kind: 'installing' } })
      let next: BundledSkillInstallState
      try {
        const outcome = await installBundledOrcaSkillsOnRuntimeTarget(runtimeTarget, {
          names: [...skillNames],
          ...wsl
        })
        next =
          outcome.kind === 'unsupported'
            ? { kind: 'legacy-terminal', command: buildLegacyNpxSkillInstallCommand(skillNames) }
            : settledState(outcome.results)
      } catch (error) {
        next = { kind: 'failed', message: bundledSkillInstallErrorMessage(error) }
      } finally {
        runningTargetKeysRef.current.delete(targetKey)
      }
      if (mountedRef.current) {
        setEntry({ targetKey, state: next })
      }
      // Why also on failure: a partial run can still have placed some skills.
      if (next.kind !== 'legacy-terminal') {
        onFinished?.()
      }
      return next
    },
    [mountedRef, onFinished, runtimeTarget, targetKey, wsl]
  )

  const retry = useCallback(() => {
    void install(lastSkillNamesRef.current)
  }, [install])

  return {
    state: entry.targetKey === targetKey ? entry.state : IDLE,
    ready: runtimeTarget !== null,
    install,
    retry
  }
}
