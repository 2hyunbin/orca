// ORCA_MACHINE_NAME separates hosts that share a home and a cloned machine-id (#32918).
import { createHash } from 'node:crypto'
import { ORCA_MACHINE_NAME_ENV } from '../../../shared/orcad-managed-launch-env'
import type { RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import type { OrcadMachineHomeDecision, OrcadMachineHomeProbe } from './orcad-machine-home'

const MACHINE_NAME_PREFIX = `${ORCA_MACHINE_NAME_ENV}=`
const BOOT_ID_PREFIX = 'ORCA_BOOT_ID='
const MACHINE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

/** Lines for the machine-home probe's hostname section. */
export const ORCAD_MACHINE_NAME_PROBE =
  `printf '${MACHINE_NAME_PREFIX}%s\\n' "\${${ORCA_MACHINE_NAME_ENV}-}";` +
  ` printf '${BOOT_ID_PREFIX}%s\\n' "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)";`

export function parseOrcadMachineNameProbe(lines: readonly string[]): {
  machineName: string | null
  bootId: string | null
} {
  const prefixed = (prefix: string): string | null =>
    lines.find((line) => line.startsWith(prefix))?.slice(prefix.length) || null
  return { machineName: prefixed(MACHINE_NAME_PREFIX), bootId: prefixed(BOOT_ID_PREFIX) }
}

export function machineKeyOf(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

/** Keep the home this machine's own records prove it uses, so a name set on a shared home strands nothing. */
export function namedMachineHome(
  probe: OrcadMachineHomeProbe,
  host: RemoteHostPlatform,
  name: string
): OrcadMachineHomeDecision {
  if (!MACHINE_NAME.test(name)) {
    throw new Error(
      `${ORCA_MACHINE_NAME_ENV} is set to "${name.slice(0, 80)}", which Orca can't use. Use 1-64 ` +
        "letters, digits, '.', '_' or '-', starting with a letter or digit, then reconnect."
    )
  }
  const { identity, claim } = probe
  const runningHere = probe.dataRootOwners.some(
    (owner) =>
      !!probe.bootId &&
      owner.bootIdentity === probe.bootId &&
      owner.machineIdentity?.toLowerCase() === identity?.machineIdentity
  )
  if (identity && claim.state === 'present') {
    if (claim.machineKey === identity.key && runningHere) {
      return { kind: 'login-home' }
    }
    // A distinct machine-id's own machine home cannot belong to a clone.
    if (claim.machineKey !== identity.key && probe.machineHomeKeys.includes(identity.key)) {
      return { kind: 'machine-home', machineKey: identity.key }
    }
  }
  return { kind: 'machine-home', machineKey: machineKeyOf(`${host.os}:name:${name}`) }
}
