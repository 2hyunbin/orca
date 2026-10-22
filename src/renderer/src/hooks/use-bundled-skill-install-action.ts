import {
  bundledSkillSetupChanges,
  type BundledSkillSetupChanges
} from '@/components/settings/bundled-skill-setup-copy'
import { useEffect, useState } from 'react'
import {
  bundledSkillInstallAction,
  type BundledSkillInstallAction
} from '../../../shared/bundled-skill-summary'
import { bundledSkillTargetKey, type BundledSkillTarget } from '@/lib/bundled-skill-target'
import { planBundledSkillsOnTarget } from '@/runtime/runtime-bundled-skills-client'
import { INSTALLED_AGENT_SKILLS_CHANGED_EVENT } from './installed-agent-skills-change-event'
import { useActiveProjectSkillRuntime } from './useActiveProjectSkillRuntime'

/** `unknown`: the owning host could not plan, including servers that need an update. */
export type BundledSkillInstallActionState =
  | (BundledSkillInstallAction & { changes?: BundledSkillSetupChanges })
  | { kind: 'loading' }
  | { kind: 'unknown' }

const LOADING: BundledSkillInstallActionState = { kind: 'loading' }
const UNKNOWN: BundledSkillInstallActionState = { kind: 'unknown' }

/** What a setup screen's button would do for `skillNames` on the agents' host, from its plan. */
export function useBundledSkillInstallAction(
  skillNames: readonly string[],
  options: { enabled: boolean; refreshKey: string; target?: BundledSkillTarget | null }
): BundledSkillInstallActionState {
  const activeTarget = useActiveProjectSkillRuntime().bundledSkillTarget
  const target = options.target === undefined ? activeTarget : options.target
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
    void (async () => {
      try {
        const request = { names: namesKey.split(',') }
        const planned = await planBundledSkillsOnTarget(target, request)
        let action: BundledSkillInstallActionState = UNKNOWN
        if (planned.kind === 'plan') {
          action = {
            ...bundledSkillInstallAction(planned.plan),
            changes: bundledSkillSetupChanges(planned.plan)
          }
        }
        if (!ignore) {
          setAnswer({ key: planKey, action })
        }
      } catch {
        if (!ignore) {
          setAnswer({ key: planKey, action: UNKNOWN })
        }
      }
    })()
    return () => {
      ignore = true
    }
  }, [planKey, namesKey, options.refreshKey, revision, target])

  return planKey && answer?.key === planKey ? answer.action : LOADING
}
