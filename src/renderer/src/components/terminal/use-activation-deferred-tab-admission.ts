import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import {
  isActivationAdmissionEligible,
  pickNextActivationDeferredTabId,
  scheduleActivationDeferredAdmission
} from './activation-deferred-tab-admission'
import { revealActivationDeferredTabs } from './background-terminal-worktree-mount'
import type { TerminalColdActivationController } from '../terminal-cold-activation'

/** Warm one deferred tab per idle effect pass after reveal; mount revision schedules the next pass without blocking the switch frame. */
export function useActivationDeferredTabAdmission(
  controller: TerminalColdActivationController
): void {
  const {
    activationDeferralPlanRevision,
    activationDeferredMountTabIdsByWorktreeRef,
    backgroundMountRevision,
    backgroundMountTabIdsByWorktreeRef,
    renderedActiveWorktreeId,
    setBackgroundMountRevision
  } = controller
  // Track peak deferral size so draining cannot make over-cap plans eligible; recheck growth because startup hydration initially exposes an empty plan.
  const admissionRef = useRef<{ worktreeId: string; maxDeferredTabCount: number } | null>(null)

  useEffect(() => {
    const worktreeId = renderedActiveWorktreeId
    if (!worktreeId) {
      return
    }
    const deferredTabCount =
      activationDeferredMountTabIdsByWorktreeRef.current.get(worktreeId)?.size ?? 0
    if (deferredTabCount === 0) {
      return
    }
    const previous = admissionRef.current
    const maxDeferredTabCount =
      previous?.worktreeId === worktreeId
        ? Math.max(previous.maxDeferredTabCount, deferredTabCount)
        : deferredTabCount
    admissionRef.current = { worktreeId, maxDeferredTabCount }
    if (!isActivationAdmissionEligible(maxDeferredTabCount)) {
      return
    }
    return scheduleActivationDeferredAdmission(() => {
      // Tabs can change between scheduling and admission; stale IDs would strand the restriction.
      const allTabIds = (useAppStore.getState().tabsByWorktree[worktreeId] ?? []).map(
        (tab) => tab.id
      )
      const nextTabId = pickNextActivationDeferredTabId(
        allTabIds,
        activationDeferredMountTabIdsByWorktreeRef.current.get(worktreeId)
      )
      if (!nextTabId) {
        return
      }
      revealActivationDeferredTabs({
        restrictions: backgroundMountTabIdsByWorktreeRef.current,
        deferredMountTabIdsByWorktree: activationDeferredMountTabIdsByWorktreeRef.current,
        worktreeId,
        allTabIds,
        immediateTabIds: new Set([nextTabId])
      })
      setBackgroundMountRevision((revision) => revision + 1)
    })
    // Why activationDeferralPlanRevision is a dep: a startup-gate-open pass can
    // install a plan for the already-active worktree by mutating only refs —
    // neither other dep changes, and without this revision the tabs stay
    // unmounted until the user switches workspaces and back.
  }, [
    activationDeferralPlanRevision,
    activationDeferredMountTabIdsByWorktreeRef,
    backgroundMountRevision,
    backgroundMountTabIdsByWorktreeRef,
    renderedActiveWorktreeId,
    setBackgroundMountRevision
  ])
}
