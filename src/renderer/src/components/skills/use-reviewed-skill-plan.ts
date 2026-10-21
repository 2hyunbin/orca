import { useEffect, useState } from 'react'
import type { BundledSkillPlan } from '../../../../shared/bundled-skill-plan'

type ReviewedPlan = { plan: BundledSkillPlan | null; loading: boolean; error: string | null }

type ForcedPlanResult = { request: string; plan: BundledSkillPlan | null; error: string | null }

/**
 * The plan the dialog shows and executes. Replace toggles re-plan with `force`, so main still
 * decides every op; the renderer never edits one. Without toggles it is the shared plan.
 */
export function useReviewedSkillPlan(
  sharedPlan: BundledSkillPlan | null,
  force: readonly string[]
): ReviewedPlan {
  // Why the shared digest: a re-check of the shared plan must re-plan the forced one too.
  const request =
    force.length > 0 && sharedPlan ? `${sharedPlan.planDigest}\n${force.join('\n')}` : ''
  const [result, setResult] = useState<ForcedPlanResult | null>(null)

  useEffect(() => {
    if (!request) {
      return
    }
    let cancelled = false
    const forced = request.split('\n').slice(1)
    window.api.skills.bundledPlan({ force: forced }).then(
      (plan) => {
        if (!cancelled) {
          setResult({ request, plan, error: null })
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setResult({
            request,
            plan: null,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [request])

  if (!request) {
    return { plan: sharedPlan, loading: false, error: null }
  }
  // Why: a result for an older toggle set is never shown as this one's.
  if (result?.request !== request) {
    return { plan: null, loading: true, error: null }
  }
  return { plan: result.plan, loading: false, error: result.error }
}
