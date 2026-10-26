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
    if (owner.machineIdentity.toLowerCase() !== identity.machineIdentity) {
      return 'foreign'
    }
    return isCloneHostname(owner.host, identity) ? 'foreign' : 'this'
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

/** Images cloned with one /etc/machine-id differ only by hostname; a recorded other hostname is a clone's. */
function isCloneHostname(recorded: string | null, identity: OrcadMachineIdentity): boolean {
  return identity.cloneKey !== null && recorded !== null && recorded !== identity.hostname
}

/** This machine's own home when the one it would use was taken by a clone. */
function cloneHomeIfTakenBy(
  recorded: string | null,
  identity: OrcadMachineIdentity
): OrcadMachineHomeDecision | null {
  return identity.cloneKey && isCloneHostname(recorded, identity)
    ? { kind: 'machine-home', machineKey: identity.cloneKey }
    : null
}

/** Homes taken before hostnames were recorded leave only their data-root owners as evidence. */
function cloneOwnerHost(
  probe: OrcadMachineHomeProbe,
  identity: OrcadMachineIdentity,
  root: string
): string | null {
  return (
    probe.dataRootOwners.find(
      (owner) =>
        owner.root === root &&
        owner.machineIdentity?.toLowerCase() === identity.machineIdentity &&
        isCloneHostname(owner.host, identity)
    )?.host ?? null
  )
}

function orcadMachineHomeFor(
  probe: OrcadMachineHomeProbe,
  identity: OrcadMachineIdentity,
  machineKey: string
): OrcadMachineHomeDecision {
  const home: OrcadMachineHomeDecision = { kind: 'machine-home', machineKey }
  if (machineKey === identity.cloneKey) {
    return home
  }
  const recorded =
    probe.machineHomes.get(machineKey) ??
    cloneOwnerHost(probe, identity, orcadMachineDataRootName(machineKey))
  return cloneHomeIfTakenBy(recorded, identity) ?? home
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
  if (identity.cloneKey && probe.machineHomes.has(identity.cloneKey)) {
    return { kind: 'machine-home', machineKey: identity.cloneKey }
  }
  if (claim.state === 'present') {
    if (claim.machineKey !== identity.key) {
      return orcadMachineHomeFor(probe, identity, identity.key)
    }
    const claimedBy = claim.hostname ?? cloneOwnerHost(probe, identity, '.orca')
    return cloneHomeIfTakenBy(claimedBy, identity) ?? { kind: 'login-home' }
  }
  const owners = probe.dataRootOwners
    .filter((owner) => owner.root === '.orca')
    .map((owner) => ownerMachine(owner, identity, host))
  if (probe.machineHomes.has(identity.key) || owners.includes('foreign')) {
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
  return cloneHomeIfTakenBy(won.hostname, identity) ?? { kind: 'login-home' }
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
