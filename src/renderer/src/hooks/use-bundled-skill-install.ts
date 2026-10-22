import { useCallback, useRef, useState } from 'react'
import {
  summarizeBundledSkillOutcomes,
  type BundledSkillResultSummary
} from '../../../shared/bundled-skill-summary'
import type { BundledSkillPlanRequest } from '../../../shared/bundled-skill-plan'
import { bundledSkillTargetKey } from '@/lib/bundled-skill-target'
import { bundledSkillInstallErrorMessage } from '@/lib/bundled-skill-install-error-message'
import {
  executeBundledSkillsOnTarget,
  planBundledSkillsOnTarget
} from '@/runtime/runtime-bundled-skills-client'
import { notifyInstalledAgentSkillsChanged } from './installed-agent-skill-discovery'
import { useActiveProjectSkillRuntime } from './useActiveProjectSkillRuntime'
import { useMountedRef } from './useMountedRef'

export type BundledSkillInstallState =
  | { kind: 'idle' }
  | { kind: 'installing' }
  | { kind: 'done'; summary: BundledSkillResultSummary }
  /** The paired host answered without the installer: "Update Orca on the server". */
  | { kind: 'unsupported' }
  /** The request itself failed; nothing says what reached the disk. */
  | { kind: 'failed'; message: string }

export type BundledSkillInstall = {
  state: BundledSkillInstallState
  /** False while the host the agents run on is unknown. */
  ready: boolean
  /** Resolves to the settled state, or null when nothing started. `force`: paths to Replace. */
  install: (
    skillNames: readonly string[],
    force?: readonly string[]
  ) => Promise<BundledSkillInstallState | null>
  /** Reruns this host's last install. */
  retry: () => void
}

const IDLE: BundledSkillInstallState = { kind: 'idle' }

/** A failed request, or a run that left something undone: "Needs attention" with Retry. */
export function bundledSkillInstallNeedsAttention(state: BundledSkillInstallState): boolean {
  return state.kind === 'failed' || (state.kind === 'done' && !state.summary.ok)
}

/**
 * Installs Orca's bundled skills for every detected agent on the host Update skills plans:
 * this machine, its WSL distro, or the paired server or SSH host (never this machine for it).
 */
export function useBundledSkillInstall(
  options: { onFinished?: () => void } = {}
): BundledSkillInstall {
  const { onFinished } = options
  const target = useActiveProjectSkillRuntime().bundledSkillTarget
  const targetKey = target ? bundledSkillTargetKey(target) : null
  // Why per target: a result belongs to the host it ran on, not the one focused now.
  const [states, setStates] = useState<ReadonlyMap<string, BundledSkillInstallState>>(new Map())
  // Why per host: an install still running on the previous host must not block this one.
  const runningRef = useRef(new Set<string>())
  const lastRequestRef = useRef(new Map<string, BundledSkillPlanRequest>())
  const mountedRef = useMountedRef()

  const install = useCallback(
    async (
      skillNames: readonly string[],
      force?: readonly string[]
    ): Promise<BundledSkillInstallState | null> => {
      if (!target || !targetKey || skillNames.length === 0) {
        return null
      }
      if (runningRef.current.has(targetKey)) {
        return null
      }
      runningRef.current.add(targetKey)
      const request: BundledSkillPlanRequest = {
        names: [...skillNames],
        ...(force && force.length > 0 ? { force: [...force] } : {})
      }
      lastRequestRef.current.set(targetKey, request)
      const setState = (state: BundledSkillInstallState): void => {
        setStates((current) => new Map(current).set(targetKey, state))
      }
      setState({ kind: 'installing' })
      let next: BundledSkillInstallState
      try {
        const planned = await planBundledSkillsOnTarget(target, request)
        next =
          planned.kind === 'unsupported'
            ? { kind: 'unsupported' }
            : {
                kind: 'done',
                summary: summarizeBundledSkillOutcomes(
                  await executeBundledSkillsOnTarget(target, planned.plan.planDigest, request)
                )
              }
      } catch (error) {
        next = { kind: 'failed', message: bundledSkillInstallErrorMessage(error) }
      } finally {
        runningRef.current.delete(targetKey)
      }
      if (mountedRef.current) {
        setState(next)
      }
      if (next.kind !== 'unsupported') {
        // Why also on failure: a partial run can still have placed some skills.
        notifyInstalledAgentSkillsChanged()
        onFinished?.()
      }
      return next
    },
    [mountedRef, onFinished, target, targetKey]
  )

  const retry = useCallback(() => {
    const request = targetKey ? lastRequestRef.current.get(targetKey) : undefined
    if (request?.names) {
      void install(request.names, request.force)
    }
  }, [install, targetKey])

  return {
    state: (targetKey && states.get(targetKey)) || IDLE,
    ready: target !== null,
    install,
    retry
  }
}
