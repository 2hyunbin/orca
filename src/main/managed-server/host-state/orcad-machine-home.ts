// Shared-home hosts need per-machine state and runtime GC: a PID can prove ownership only on the machine that issued it (#29059).
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { RELAY_REMOTE_DIR } from '../../ssh/remote-exec/remote-frame-protocol'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import {
  ORCAD_MACHINE_CLAIM_FILENAME,
  ORCAD_MACHINE_HOMES_DIRNAME,
  orcadMachineOwnerRecord,
  type OrcadDataRootOwner,
  type OrcadMachineHomeProbe,
  type OrcadMachineIdentity
} from './orcad-machine-home-probe'

type OrcadMachineHomeDecision =
  | { kind: 'login-home' }
  | { kind: 'claim'; machineKey: string }
  | { kind: 'machine-home'; machineKey: string }
  /** Shared pre-claim installs require attribution before takeover. */
  | { kind: 'unresolved'; machineKey: string; cause: OrcadMachineOwnershipUnresolvedCause }

type OrcadMachineOwnershipUnresolvedCause = 'stopped-install' | 'unattributed-owner'

function ownerMachine(
  owner: OrcadDataRootOwner,
  identity: OrcadMachineIdentity,
  host: RemoteHostPlatform
): 'this' | 'foreign' | 'unknown' {
  if (owner.machineIdentity) {
    // A clone sharing this machine-id is judged separately by cloneIsUsing.
    return owner.machineIdentity.toLowerCase() === identity.machineIdentity ? 'this' : 'foreign'
  }
  // Older owners lack machine identity, leaving only weaker hostname evidence.
  if (!owner.host || !identity.hostname) {
    return 'unknown'
  }
  if (owner.host === identity.hostname) {
    return 'this'
  }
  // Network changes rename Macs, so differing hostnames cannot prove foreign ownership.
  return host.os === 'darwin' ? 'unknown' : 'foreign'
}

/**
 * Linux images cloned with one /etc/machine-id differ only by hostname and boot. Require positive
 * evidence: a shared filesystem and an owner record from another host and boot. A renamed host
 * keeps its boot, and a local disk has one machine.
 */
function cloneIsUsing(
  probe: OrcadMachineHomeProbe,
  identity: OrcadMachineIdentity,
  root: string
): boolean {
  if (!identity.cloneKey || !identity.bootId || probe.homeOnLocalDisk) {
    return false
  }
  const owners = probe.dataRootOwners.filter(
    (owner) =>
      owner.root === root && owner.machineIdentity?.toLowerCase() === identity.machineIdentity
  )
  const clone = owners.some(
    (owner) =>
      owner.host !== null &&
      owner.host !== identity.hostname &&
      !!owner.bootIdentity &&
      owner.bootIdentity !== identity.bootId
  )
  // This machine already writes there too: stay, and its server's lock refuses the second writer.
  const ours = owners.some(
    (owner) => owner.host === identity.hostname || owner.bootIdentity === identity.bootId
  )
  return clone && !ours
}

function orcadMachineHomeFor(
  probe: OrcadMachineHomeProbe,
  identity: OrcadMachineIdentity,
  machineKey: string
): OrcadMachineHomeDecision {
  return identity.cloneKey &&
    machineKey !== identity.cloneKey &&
    cloneIsUsing(probe, identity, orcadMachineDataRootName(machineKey))
    ? { kind: 'machine-home', machineKey: identity.cloneKey }
    : { kind: 'machine-home', machineKey }
}

/** The login home claimed with this machine-id, unless a clone proves it is the one using it. */
function claimedLoginHome(
  probe: OrcadMachineHomeProbe,
  identity: OrcadMachineIdentity,
  claimedBy: string | null
): OrcadMachineHomeDecision {
  return claimedBy !== identity.hostname && cloneIsUsing(probe, identity, '.orca')
    ? orcadMachineHomeFor(probe, identity, identity.key)
    : { kind: 'login-home' }
}

/** Keep established machine homes stable; refuse ambiguous prior owners or unreadable claims before risking another machine's state. */
export function decideOrcadMachineHome(
  probe: OrcadMachineHomeProbe,
  host: RemoteHostPlatform
): OrcadMachineHomeDecision {
  const { identity, claim } = probe
  if (!identity) {
    return { kind: 'login-home' }
  }
  if (claim.state === 'unreadable') {
    throw new Error(
      `orcad cannot tell which machine owns ${RELAY_REMOTE_DIR}/${ORCAD_MACHINE_CLAIM_FILENAME}: ${claim.reason}`
    )
  }
  if (identity.cloneKey && probe.machineHomeKeys.includes(identity.cloneKey)) {
    return { kind: 'machine-home', machineKey: identity.cloneKey }
  }
  if (claim.state === 'present') {
    if (claim.machineKey !== identity.key) {
      return orcadMachineHomeFor(probe, identity, identity.key)
    }
    return claimedLoginHome(probe, identity, claim.hostname)
  }
  const owners = probe.dataRootOwners
    .filter((owner) => owner.root === '.orca')
    .map((owner) => ownerMachine(owner, identity, host))
  // A clone running in this key's machine home leaves the login home to this machine.
  const ownsKeyHome =
    probe.machineHomeKeys.includes(identity.key) &&
    !cloneIsUsing(probe, identity, orcadMachineDataRootName(identity.key))
  if (ownsKeyHome || owners.includes('foreign') || cloneIsUsing(probe, identity, '.orca')) {
    return orcadMachineHomeFor(probe, identity, identity.key)
  }
  if (probe.homeOnLocalDisk) {
    return { kind: 'claim', machineKey: identity.key }
  }
  // Unknown ownership could admit a second writer whose PIDs are judged on the wrong host.
  if (owners.includes('unknown')) {
    return { kind: 'unresolved', machineKey: identity.key, cause: 'unattributed-owner' }
  }
  return probe.loginHomeInstalled && owners.length === 0
    ? { kind: 'unresolved', machineKey: identity.key, cause: 'stopped-install' }
    : { kind: 'claim', machineKey: identity.key }
}

export function orcadMachineOwnershipUnresolvedMessage(
  machineKey: string,
  hostname: string | null,
  cause: OrcadMachineOwnershipUnresolvedCause = 'stopped-install'
): string {
  const claim = quotePosixShell(orcadMachineOwnerRecord(machineKey, hostname))
  const path = `~/${RELAY_REMOTE_DIR}/${ORCAD_MACHINE_CLAIM_FILENAME}`
  const why =
    cause === 'stopped-install'
      ? 'that stopped server left no record of its own'
      : 'the older Orca server there recorded only a hostname, which does not identify its machine'
  return (
    `Orca can't tell which machine set up the Orca server in ~/${RELAY_REMOTE_DIR}: ` +
    `this home may be shared by several machines, and ${why}. ` +
    'If another machine set it up, connect to that one and run the command shown there. ' +
    `If ${hostname ?? 'this machine'} set it up, run this on it, then reconnect: ` +
    `mkdir -p ~/${RELAY_REMOTE_DIR} && printf '%s' ${claim} > ${path}`
  )
}

/** Settle a claim race: losing to a clone of this machine still needs a home of its own. */
export function decideOrcadMachineHomeAfterClaim(
  probe: OrcadMachineHomeProbe,
  won: { machineKey: string; hostname: string | null }
): OrcadMachineHomeDecision {
  const { identity } = probe
  if (!identity) {
    return { kind: 'login-home' }
  }
  if (won.machineKey !== identity.key) {
    return orcadMachineHomeFor(probe, identity, identity.key)
  }
  return claimedLoginHome(probe, identity, won.hostname)
}

export function orcadMachineHomeDir(
  host: RemoteHostPlatform,
  loginHome: string,
  machineKey: string
): string {
  return joinRemotePath(host, loginHome, RELAY_REMOTE_DIR, ORCAD_MACHINE_HOMES_DIRNAME, machineKey)
}

/** Keep data roots shallow beside ~/.orca so long shared-home paths fit Unix socket limits. */
export function orcadMachineDataRoot(
  host: RemoteHostPlatform,
  loginHome: string,
  machineKey: string
): string {
  return joinRemotePath(host, loginHome, orcadMachineDataRootName(machineKey))
}

function orcadMachineDataRootName(machineKey: string): string {
  return `.orca-${machineKey.slice(0, 8)}`
}
