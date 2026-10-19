/**
 * The orcad a WSL host already runs, read before an app update replaces it (Track E1). SSH asks
 * it through its tunnel; a WSL host has no standing tunnel during deploy, so this opens a
 * short-lived stdio bridge. Anything unproven reads as an unverifiable census, never zero.
 */
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { parsePairingCode } from '../../shared/pairing'
import { ORCAD_MANAGED_REMOTE_PORT } from '../../shared/orcad-managed-runtime'
import type { OrcadTerminalCensus } from '../../shared/orcad-terminal-census'
import type { ServeReadiness } from '../server/serve-readiness'
import { probeActiveOrcadReadiness } from '../ssh/orcad-active-readiness'
import { orcadBoundPort } from '../managed-server/lifecycle/orcad-managed-bound-port'
import { managedOrcadInstallDir } from '../managed-server/lifecycle/orcad-managed-runtime-context'
import { wakeStoppedManagedOrcad } from '../managed-server/lifecycle/orcad-managed-wake'
import type { OrcadRemoteContext } from '../managed-server/install/orcad-remote-context'
import type { OrcadSlotOptions } from '../ssh/orcad-recovery-slot'
import { readRemoteOrcadBuildHash } from '../managed-server/install/orcad-remote-build-hash'
import { requestOrcadTerminalCensus } from '../ssh/orcad-terminal-census-client'
import {
  orcadRestartAdmissionPort,
  type OrcadIncumbentConnector,
  type OrcadRestartAdmissionPort
} from '../ssh/orcad-restart-admission-client'
import { tunneledOrcadPairingCode } from '../ssh/orcad-tunneled-pairing'
import type { StartedPortForward } from '../ssh/port-forwarding/ssh-port-forward-provider'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'
import { listenWslOrcadStdioBridge } from './wsl-orcad-stdio-bridge'

export type WslOrcadIncumbent = {
  census: OrcadTerminalCensus
  /** The incumbent's proven readiness; null when it could not be started or proven. */
  readiness: ServeReadiness | null
  /** Reserves its restart over a fresh bridge (no wake) under the fence; null without readiness. */
  restartAdmission: OrcadRestartAdmissionPort | null
  /** Fresh proof (no wake) for explicit Force on a host that predates restart admission; never
   *  zero unread. */
  recount: () => Promise<OrcadTerminalCensus>
}

const UNVERIFIABLE: OrcadTerminalCensus = {
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null
}

const UNREADABLE: WslOrcadIncumbent = {
  census: UNVERIFIABLE,
  readiness: null,
  recount: async () => UNVERIFIABLE,
  restartAdmission: null
}

export type WslOrcadIncumbentDependencies = {
  wake: typeof wakeStoppedManagedOrcad
  probe: typeof probeActiveOrcadReadiness
  readBuildHash: typeof readRemoteOrcadBuildHash
  listen: (
    transport: OrcadHostTransport,
    remotePort: number,
    target: WslOrcadHostTarget
  ) => Promise<StartedPortForward>
  census: typeof requestOrcadTerminalCensus
  restartAdmission: typeof orcadRestartAdmissionPort
}

const DEFAULT_DEPENDENCIES: WslOrcadIncumbentDependencies = {
  wake: wakeStoppedManagedOrcad,
  probe: probeActiveOrcadReadiness,
  readBuildHash: readRemoteOrcadBuildHash,
  listen: (transport, remotePort, target) =>
    listenWslOrcadStdioBridge(transport, {
      environmentId: target.id,
      remotePort,
      localPort: 0,
      label: `Orca server in WSL: ${target.label} (update check)`
    }),
  census: requestOrcadTerminalCensus,
  restartAdmission: orcadRestartAdmissionPort
}

/**
 * Wakes the active slot if a reboot or idle exit stopped it (its daemon then starts empty, so
 * the census proves zero), then asks it for its census over a bridge closed before returning.
 */
export async function readWslOrcadIncumbent(
  args: {
    context: OrcadRemoteContext<WslOrcadHostTarget>
    slot: OrcadSlotOptions
  },
  dependencies: WslOrcadIncumbentDependencies = DEFAULT_DEPENDENCIES
): Promise<WslOrcadIncumbent> {
  const record = args.context.activationRecord
  const activatedAt = record.activatedAt ? Date.parse(record.activatedAt) : Number.NaN
  if (!record.active || !Number.isFinite(activatedAt) || activatedAt < 0) {
    return UNREADABLE
  }
  let readiness: ServeReadiness
  try {
    const wake = await dependencies.wake(args.slot)
    if (wake.outcome === 'started') {
      readiness = wake.readiness
    } else if (wake.outcome === 'serving') {
      const remoteInstallDir = managedOrcadInstallDir(args.context, record.active)
      readiness = await dependencies.probe(
        { ...args.slot, remoteInstallDir },
        {
          buildHash: await dependencies.readBuildHash(args.slot, remoteInstallDir),
          fullVersion: record.active
        }
      )
    } else {
      return UNREADABLE
    }
  } catch {
    return UNREADABLE
  }
  const connect = incumbentConnector(args, readiness, dependencies)
  // Why release: finished automation shells would otherwise defer every update, as on SSH.
  const census = await connect((connection) =>
    dependencies.census(connection, activatedAt, undefined, {
      releaseFinishedAutomationTerminals: true
    })
  ).catch(() => UNVERIFIABLE)
  return {
    census,
    readiness,
    recount: () =>
      connect((connection) => dependencies.census(connection, activatedAt)).catch(
        () => UNVERIFIABLE
      ),
    restartAdmission: dependencies.restartAdmission(connect, activatedAt)
  }
}

/** One request per bridge, closed before returning: a WSL deploy holds no standing tunnel. */
function incumbentConnector(
  args: { context: OrcadRemoteContext<WslOrcadHostTarget>; slot: OrcadSlotOptions },
  readiness: ServeReadiness,
  dependencies: WslOrcadIncumbentDependencies
): OrcadIncumbentConnector {
  const port = orcadBoundPort(readiness) ?? ORCAD_MANAGED_REMOTE_PORT
  return (run) =>
    dependencies.listen(args.slot.conn, port, args.context.target).then((forward) =>
      Promise.resolve()
        .then(() => {
          const code = tunneledOrcadPairingCode(readiness, forward.entry.localPort)
          const offer = parsePairingCode(code)
          if (!offer) {
            throw new Error('The Orca server in WSL did not offer a pairing for its bridge.')
          }
          return run(pairedRuntimeConnectionFromOffer(offer))
        })
        .finally(() => forward.close().catch(() => {}))
    )
}
