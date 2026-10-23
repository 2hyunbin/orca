/**
 * Runs `orcad --reclaim-stale-lock` from a managed host's active slot, for a start refused because
 * its instance lock may belong to another machine sharing the home (#32177). The slot's own build
 * gathers the evidence and clears the lock; this client only relays the user's confirmation.
 */
import { z } from 'zod'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  ORCAD_RECLAIM_STALE_LOCK_FLAG,
  ORCAD_STALE_LOCK_DATA_ROOT_FLAG
} from '../../../shared/orcad-stale-lock-reclaim'
import type { OrcadManagedStaleLockReclaimResult } from '../../../shared/orcad-managed-runtime'
import { withOrcadActivationLock } from '../activation/orcad-activation-lock'
import { readOrcadActivationRecord } from '../activation/orcad-activation-record-store'
import { withManagedOrcadLifecycle } from '../../ssh/orcad-runtime-maintenance'
import { managedOrcadSlot, resolveLinkedOrcadContext } from './orcad-managed-runtime-context'
import { selectOrcadSlotRuntimeCommand } from '../install/orcad-remote-runtime'
import { execOrcadRemote } from '../install/orcad-remote-runtime-control'
import { orcadSlotDir, type OrcadSlotOptions } from '../../ssh/orcad-recovery-slot'
import { joinRemotePath } from '../../ssh/ssh-remote-platform'
import { isSshCommandExitError } from '../../ssh/remote-exec/remote-exec-command'
import { wakeStoppedManagedOrcad } from './orcad-managed-wake'
import { rebuildOrcadManagedTunnel } from './orcad-managed-tunnel'

const ReclaimAnswerSchema = z.object({
  status: z.enum(['none', 'eligible', 'refused', 'reclaimed']),
  lockPath: z.string(),
  message: z.string(),
  evidence: z
    .object({
      pid: z.number(),
      host: z.string(),
      bootId: z.string(),
      currentBootId: z.string(),
      ageMinutes: z.number()
    })
    .optional()
})

type ReclaimAnswer = z.infer<typeof ReclaimAnswerSchema>

type SlotReclaim =
  | { status: 'answered'; answer: ReclaimAnswer }
  | { status: 'unsupported' | 'busy'; message: string }

export function runManagedOrcadStaleLockReclaim(
  userDataPath: string,
  selector: string,
  options: { yes: boolean }
): Promise<OrcadManagedStaleLockReclaimResult> {
  return withManagedOrcadLifecycle(userDataPath, selector, async ({ environment, deployment }) => {
    const context = await resolveLinkedOrcadContext(environment, deployment)
    // Only Linux starts refuse a lock another machine may hold; elsewhere the slot has no such lock.
    if (context.host.os !== 'linux') {
      return unsupported('This host’s Orca server has no stale-lock recovery.')
    }
    const slot = managedOrcadSlot(context, deployment.remotePort)
    // Serialized with launches, so a wake never reads the lock while it is being cleared.
    const ran = await withOrcadActivationLock(
      slot,
      () => runOnActiveSlot(slot, options.yes),
      (): SlotReclaim => ({
        status: 'busy',
        message: 'An update, rollback or recovery holds this host; try again when it finishes.'
      })
    )
    if (ran.status !== 'answered') {
      return { status: ran.status, message: ran.message }
    }
    const { answer } = ran
    if (answer.status !== 'reclaimed') {
      return { ...answer, status: answer.status }
    }
    const reclaimed = {
      status: 'reclaimed',
      environmentId: environment.id,
      message: answer.message,
      lockPath: answer.lockPath
    } as const
    const wake = await wakeStoppedManagedOrcad(slot)
    if (wake.outcome !== 'started' && wake.outcome !== 'serving') {
      return {
        ...reclaimed,
        notRestarted:
          wake.outcome === 'recovery-refused'
            ? wake.reason
            : `The lock was cleared, but this host’s Orca server did not start (${wake.outcome}); reconnect to start it.`
      }
    }
    // The started server may have bound another port than the forward in use.
    await rebuildOrcadManagedTunnel(userDataPath, environment.id)
    return reclaimed
  })
}

async function runOnActiveSlot(slot: OrcadSlotOptions, yes: boolean): Promise<SlotReclaim> {
  // Re-read under the fence: another client may have changed the active slot.
  const active = (await readOrcadActivationRecord(slot)).active
  if (!active) {
    return { status: 'unsupported', message: 'This host has no activated Orca server.' }
  }
  const slotDir = orcadSlotDir(slot, active)
  const entry = joinRemotePath(slot.host, slotDir, 'orcad.js')
  const command =
    `${selectOrcadSlotRuntimeCommand(slot.host, slotDir, '')} && ` +
    `"$orcad_runtime" ${quotePosixShell(entry)} ${ORCAD_RECLAIM_STALE_LOCK_FLAG} ` +
    `${ORCAD_STALE_LOCK_DATA_ROOT_FLAG} ${quotePosixShell(slot.userDataDir)} --json${yes ? ' --yes' : ''}`
  let output: string
  try {
    output = await execOrcadRemote(slot, command)
  } catch (error) {
    // Every status but `reclaimed` exits non-zero and still prints its answer.
    if (!isSshCommandExitError(error)) {
      throw error
    }
    output = error.stdout
  }
  const answer = parseReclaimAnswer(output)
  return answer
    ? { status: 'answered', answer }
    : unsupported('This host’s Orca server gave no answer to the stale-lock recovery.')
}

function parseReclaimAnswer(output: string): ReclaimAnswer | null {
  const line = output
    .trim()
    .split('\n')
    .findLast((candidate) => candidate.trim().startsWith('{'))
  if (!line) {
    return null
  }
  try {
    const parsed = ReclaimAnswerSchema.safeParse(JSON.parse(line))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function unsupported(message: string): { status: 'unsupported'; message: string } {
  return { status: 'unsupported', message }
}
