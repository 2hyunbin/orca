/**
 * Runs `orcad --reclaim-stale-lock` from a managed host's active slot, for a start refused because
 * its instance lock may belong to another machine sharing the home (#32177). The slot's own build
 * gathers the evidence and clears the lock; this client only relays the user's confirmation.
 */
import { z } from 'zod'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  ORCAD_RECLAIM_STALE_LOCK_FLAG,
  ORCAD_STALE_LOCK_DATA_ROOT_FLAG,
  ORCAD_STALE_LOCK_EXPECT_NONCE_FLAG
} from '../../../shared/orcad-stale-lock-reclaim'
import type {
  OrcadManagedStaleLockReclaimRequest,
  OrcadManagedStaleLockReclaimResult
} from '../../../shared/orcad-managed-runtime'
import {
  ORCAD_LAUNCHER_FILENAME,
  ORCAD_SERVER_ENTRY_FILENAME
} from '../../../shared/orcad-artifacts'
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
import { ORCAD_LOCK_FILE_NAME } from '../../orcad/orcad-instance-lock'
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
      ageMinutes: z.number(),
      nonce: z.string().optional()
    })
    .optional()
})

const RECLAIM_UNSUPPORTED_SENTINEL = 'ORCA_STALE_LOCK_RECLAIM_UNSUPPORTED'

type ReclaimAnswer = z.infer<typeof ReclaimAnswerSchema>

type SlotReclaim =
  | { status: 'answered'; answer: ReclaimAnswer }
  | { status: 'unsupported' | 'busy'; message: string }

export function runManagedOrcadStaleLockReclaim(
  userDataPath: string,
  selector: string,
  request: OrcadManagedStaleLockReclaimRequest
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
      () => runOnActiveSlot(slot, request),
      (): SlotReclaim => ({
        status: 'busy',
        message: 'An update, rollback or recovery holds this host; try again when it finishes.'
      })
    )
    if (ran.status !== 'answered') {
      return ran.status === 'busy'
        ? { status: 'busy', message: ran.message }
        : {
            status: 'unsupported',
            message: ran.message,
            lockPath: joinRemotePath(slot.host, slot.userDataDir, ORCAD_LOCK_FILE_NAME)
          }
    }
    const { answer } = ran
    if (answer.status !== 'reclaimed') {
      return { ...answer, status: answer.status }
    }
    const reclaimed = {
      status: 'reclaimed',
      environmentId: environment.id,
      message: answer.message,
      lockPath: answer.lockPath,
      ...(answer.evidence ? { evidence: answer.evidence } : {})
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

async function runOnActiveSlot(
  slot: OrcadSlotOptions,
  request: OrcadManagedStaleLockReclaimRequest
): Promise<SlotReclaim> {
  // Re-read under the fence: another client may have changed the active slot.
  const active = (await readOrcadActivationRecord(slot)).active
  if (!active) {
    return { status: 'unsupported', message: 'This host has no activated Orca server.' }
  }
  const slotDir = orcadSlotDir(slot, active)
  const entry = joinRemotePath(slot.host, slotDir, ORCAD_LAUNCHER_FILENAME)
  const bundle = joinRemotePath(slot.host, slotDir, ORCAD_SERVER_ENTRY_FILENAME)
  // The confirmation clears only the record the user approved, never one written since.
  const confirm = request.yes
    ? ` ${ORCAD_STALE_LOCK_EXPECT_NONCE_FLAG} ${quotePosixShell(request.expectNonce)} --yes`
    : ''
  // Why first: an orcad without the flag would ignore it and start serving in the foreground, and
  // one without the nonce pin could clear a lock written after the check.
  const command =
    `if grep -qF -- ${quotePosixShell(ORCAD_STALE_LOCK_EXPECT_NONCE_FLAG)} ${quotePosixShell(bundle)} 2>/dev/null; then ` +
    `${selectOrcadSlotRuntimeCommand(slot.host, slotDir, '')} && ` +
    `"$orcad_runtime" ${quotePosixShell(entry)} ${ORCAD_RECLAIM_STALE_LOCK_FLAG} ` +
    `${ORCAD_STALE_LOCK_DATA_ROOT_FLAG} ${quotePosixShell(slot.userDataDir)} --json${confirm}; ` +
    `else echo ${RECLAIM_UNSUPPORTED_SENTINEL}; fi`
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
  if (output.split('\n').some((line) => line.trim() === RECLAIM_UNSUPPORTED_SENTINEL)) {
    return unsupported('This host’s Orca server predates the stale-lock recovery.')
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
