import { useSyncExternalStore } from 'react'
import type { BundledSkillInstallResult } from '../../../../shared/bundled-skill-plan'
import {
  summarizeBundledSkillOutcomes,
  type BundledSkillResultSummary
} from '../../../../shared/bundled-skill-summary'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import {
  getSkillFreshnessUpdateDialogRequest,
  subscribeSkillFreshnessUpdateDialog
} from './skill-freshness-update-dialog'

/** The host whose skills a run changed; WSL and paired hosts get their own key later. */
export const LOCAL_SKILL_UPDATE_TARGET = 'local'

export type SkillUpdateRun =
  | { state: 'idle' }
  | { state: 'running'; targetKey: string; names: string[]; startedAt: number }
  | {
      state: 'done'
      targetKey: string
      names: string[]
      finishedAt: number
      result: BundledSkillInstallResult
      summary: BundledSkillResultSummary
      needsAttention: boolean
    }
  /** The request itself failed; nothing says what reached the disk. */
  | { state: 'error'; targetKey: string; names: string[]; finishedAt: number; message: string }

type RunSlot = {
  run: SkillUpdateRun
  token: number
  successTimer: ReturnType<typeof setTimeout> | null
}

const IDLE: SkillUpdateRun = Object.freeze({ state: 'idle' })
// Why per target: a run on one host must never overwrite, or be overwritten by, another's.
const slots = new Map<string, RunSlot>()
const listeners = new Set<() => void>()
let nextToken = 0

/** How long a finished run keeps its green check in the status bar. */
export const SKILL_UPDATE_SUCCESS_LINGER_MS = 4000

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function slotFor(targetKey: string): RunSlot {
  let slot = slots.get(targetKey)
  if (!slot) {
    slot = { run: IDLE, token: 0, successTimer: null }
    slots.set(targetKey, slot)
  }
  return slot
}

function isSuccess(run: SkillUpdateRun): boolean {
  return run.state === 'done' && run.summary.ok && !run.needsAttention
}

function clearSuccessTimer(slot: RunSlot): void {
  if (slot.successTimer) {
    clearTimeout(slot.successTimer)
    slot.successTimer = null
  }
}

/**
 * Why: a success needs to be *seen*, then get out of the way. Problems stay until the user
 * acts on them, and while the dialog is open closing it is what acknowledges the run.
 */
function scheduleSuccessLinger(targetKey: string): void {
  const slot = slotFor(targetKey)
  clearSuccessTimer(slot)
  if (!isSuccess(slot.run) || getSkillFreshnessUpdateDialogRequest()) {
    return
  }
  slot.successTimer = setTimeout(() => {
    slot.successTimer = null
    acknowledgeSkillUpdateRun(targetKey)
  }, SKILL_UPDATE_SUCCESS_LINGER_MS)
}

// Opening the dialog on a lingering success hands ownership back to it.
subscribeSkillFreshnessUpdateDialog(() => {
  for (const targetKey of slots.keys()) {
    scheduleSuccessLinger(targetKey)
  }
})

function setRun(targetKey: string, run: SkillUpdateRun): void {
  slotFor(targetKey).run = run
  scheduleSuccessLinger(targetKey)
  emit()
}

export function subscribeSkillUpdateRun(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSkillUpdateRun(targetKey: string = LOCAL_SKILL_UPDATE_TARGET): SkillUpdateRun {
  return slots.get(targetKey)?.run ?? IDLE
}

export function useSkillUpdateRun(targetKey: string = LOCAL_SKILL_UPDATE_TARGET): SkillUpdateRun {
  const read = (): SkillUpdateRun => getSkillUpdateRun(targetKey)
  return useSyncExternalStore(subscribeSkillUpdateRun, read, read)
}

/** Executes the plan the user reviewed, identified by its digest. */
export async function startSkillUpdateRun(request: {
  /** Only the local host has a plan route in this build. */
  targetKey: typeof LOCAL_SKILL_UPDATE_TARGET
  names: string[]
  planDigest: string
  force: string[]
}): Promise<void> {
  const { targetKey, names } = request
  const slot = slotFor(targetKey)
  if (slot.run.state === 'running') {
    return
  }
  const token = ++nextToken
  slot.token = token
  setRun(targetKey, { state: 'running', targetKey, names, startedAt: Date.now() })
  const settled = await window.api.skills
    .bundledExecute({ planDigest: request.planDigest, force: request.force })
    .then(
      (result): SkillUpdateRun => {
        const summary = summarizeBundledSkillOutcomes(result)
        return {
          state: 'done',
          targetKey,
          names,
          finishedAt: Date.now(),
          result,
          summary,
          needsAttention: summary.skills.some((skill) => skill.text === 'Needs attention')
        }
      },
      (error: unknown): SkillUpdateRun => ({
        state: 'error',
        targetKey,
        names,
        finishedAt: Date.now(),
        message: error instanceof Error ? error.message : String(error)
      })
    )
  // Why: a completion for a run that was acknowledged or replaced is stale.
  if (slots.get(targetKey)?.token !== token) {
    return
  }
  setRun(targetKey, settled)
  // A run of any outcome may have changed the disk, so every skills surface re-reads it.
  notifyInstalledAgentSkillsChanged()
}

/** Clears a settled run so the status-bar segment can retire itself. */
export function acknowledgeSkillUpdateRun(targetKey: string = LOCAL_SKILL_UPDATE_TARGET): void {
  const slot = slots.get(targetKey)
  if (!slot || slot.run.state === 'idle' || slot.run.state === 'running') {
    return
  }
  clearSuccessTimer(slot)
  slot.token = ++nextToken
  setRun(targetKey, IDLE)
}

/** @internal - tests need a clean module between cases. */
export function _resetSkillUpdateRunStore(): void {
  for (const slot of slots.values()) {
    clearSuccessTimer(slot)
  }
  slots.clear()
  listeners.clear()
}
