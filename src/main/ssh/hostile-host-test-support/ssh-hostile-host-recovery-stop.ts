/**
 * Recovery's stop on a real host: crash recovery must end a server whose restart admission is
 * refusing. A restart reservation held by another client (mid-update) is that refusal: an older
 * client's empty update request defers behind it, and recovery's stop must not.
 */
import { expect } from 'vitest'
import { pairedRuntimeConnectionFromOffer } from '../../../shared/paired-runtime-connection'
import { parsePairingCode } from '../../../shared/pairing'
import { ORCAD_STOP_REQUEST_FILENAME } from '../../../shared/orcad-stop-request'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { readOrcadActivationRecord } from '../../managed-server/activation/orcad-activation-record-store'
import { orcadBoundPort } from '../../managed-server/lifecycle/orcad-managed-bound-port'
import { OrcadManagedTunnelTransportProvider } from '../../managed-server/lifecycle/orcad-managed-tunnel-transport'
import {
  parseOrcadReadinessWaitOutput,
  readOrcadReadinessNowCommand
} from '../../managed-server/install/orcad-remote-readiness-wait'
import {
  orcadLivenessProbeCommand,
  parseOrcadLiveness
} from '../../managed-server/install/orcad-remote-launch'
import { execOrcadRemote } from '../../managed-server/install/orcad-remote-runtime-control'
import {
  ensureOrcadSlotServing,
  quiesceInterruptedOrcadSlot,
  resolveOrcadSlotIdentity,
  type OrcadSlotOptions
} from '../orcad-recovery-slot'
import { orcadRestartAdmissionPort } from '../orcad-restart-admission-client'
import { tunneledOrcadPairingCode } from '../orcad-tunneled-pairing'
import { joinRemotePath } from '../ssh-remote-platform'

const REQUEST_CONSUMED_TIMEOUT_MS = 15_000

/** Ends with the slot serving again, so the caller's decommission still has a live server. */
export async function proveRecoveryStopsRefusingOrcad(
  slot: OrcadSlotOptions,
  slotDir: string,
  version: string
): Promise<void> {
  const liveness = async (): Promise<string> =>
    parseOrcadLiveness(await execOrcadRemote(slot, orcadLivenessProbeCommand(slot.host, slotDir)))
  const parsed = parseOrcadReadinessWaitOutput(
    slot.host,
    await execOrcadRemote(slot, readOrcadReadinessNowCommand(slot.host, slotDir))
  )
  if (parsed.state !== 'ready') {
    throw new Error(`The active orcad is not ready: ${JSON.stringify(parsed)}`)
  }
  const { activatedAt } = await readOrcadActivationRecord(slot)
  const remotePort = orcadBoundPort(parsed.readiness)
  if (!activatedAt || remotePort === null) {
    throw new Error('The active orcad has no activation time or bound port.')
  }
  const tunnel = await new OrcadManagedTunnelTransportProvider().start(slot.conn, {
    id: 'recovery-stop-cell',
    connectionId: 'recovery-stop-cell',
    localHost: '127.0.0.1',
    localPort: 0,
    remoteHost: '127.0.0.1',
    remotePort
  })
  try {
    const offer = parsePairingCode(
      tunneledOrcadPairingCode(parsed.readiness, tunnel.entry.localPort)
    )
    if (!offer) {
      throw new Error('The active orcad offered no pairing through its tunnel.')
    }
    const connection = pairedRuntimeConnectionFromOffer(offer)
    const admission = orcadRestartAdmissionPort((run) => run(connection), Date.parse(activatedAt))
    expect(await admission.reserve(true)).toMatchObject({ status: 'reserved' })
    expect(await admission.reserve(true)).toMatchObject({
      status: 'defer',
      reason: expect.stringMatching(/admitting work/u)
    })
    // An older client's update request: consumed, and deferred behind the held reservation.
    const request = quotePosixShell(joinRemotePath(slot.host, slotDir, ORCAD_STOP_REQUEST_FILENAME))
    await execOrcadRemote(slot, `: > ${request}`)
    const deadline = Date.now() + REQUEST_CONSUMED_TIMEOUT_MS
    while ((await execOrcadRemote(slot, `test -e ${request} && echo PENDING || true`)).trim()) {
      if (Date.now() > deadline) {
        throw new Error('orcad did not consume the empty stop request.')
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    expect(await liveness()).toBe('LIVE')
    // Recovery's own quiesce, whose stop writes `stop-now`; no second slot is being restored.
    expect(await quiesceInterruptedOrcadSlot(slot, version, null)).toBe('exited')
    expect(await liveness()).toBe('DEAD')
  } finally {
    await tunnel.close().catch(() => {})
  }
  await ensureOrcadSlotServing(slot, await resolveOrcadSlotIdentity(slot, version))
  expect(await liveness()).toBe('LIVE')
}
