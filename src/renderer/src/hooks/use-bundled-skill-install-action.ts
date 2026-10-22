import { useEffect, useState } from 'react'
import {
  bundledSkillInstallAction,
  type BundledSkillInstallAction
} from '../../../shared/bundled-skill-summary'
import { bundledSkillTargetKey } from '@/lib/bundled-skill-target'
import { planBundledSkillsOnTarget } from '@/runtime/runtime-bundled-skills-client'
import { INSTALLED_AGENT_SKILLS_CHANGED_EVENT } from './installed-agent-skills-change-event'
import { useActiveProjectSkillRuntime } from './useActiveProjectSkillRuntime'

/** `unknown`: the host could not plan (an old server, or a stopped WSL distro). */
export type BundledSkillInstallActionState =
  | BundledSkillInstallAction
  | { kind: 'loading' }
  | { kind: 'unknown' }

const LOADING: BundledSkillInstallActionState = { kind: 'loading' }
const UNKNOWN: BundledSkillInstallActionState = { kind: 'unknown' }

/** What a setup screen's button would do for `skillNames` on the agents' host, from its plan. */
export function useBundledSkillInstallAction(
  skillNames: readonly string[],
  options: { enabled: boolean; refreshKey: string }
): BundledSkillInstallActionState {
  const target = useActiveProjectSkillRuntime().bundledSkillTarget
  const targetKey = target ? bundledSkillTargetKey(target) : null
  const namesKey = skillNames.join(',')
  const planKey = options.enabled && targetKey ? `${targetKey}|${namesKey}` : null
  const [answer, setAnswer] = useState<{ key: string; action: BundledSkillInstallActionState }>()
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const onChanged = (): void => setRevision((value) => value + 1)
    window.addEventListener(INSTALLED_AGENT_SKILLS_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(INSTALLED_AGENT_SKILLS_CHANGED_EVENT, onChanged)
  }, [])

  useEffect(() => {
    if (!planKey || !target) {
      return
    }
    let ignore = false
    // Why background: a check nobody clicked must not boot a stopped WSL distro.
    planBundledSkillsOnTarget(target, { names: namesKey.split(',') }, { background: true }).then(
      (planned) => {
        if (!ignore) {
          setAnswer({
            key: planKey,
            action: planned.kind === 'plan' ? bundledSkillInstallAction(planned.plan) : UNKNOWN
          })
        }
      },
      () => {
        if (!ignore) {
          setAnswer({ key: planKey, action: UNKNOWN })
        }
      }
    )
    return () => {
      ignore = true
    }
  }, [planKey, namesKey, options.refreshKey, revision, target])

  return planKey && answer?.key === planKey ? answer.action : LOADING
}
