// Read who owns a shared home's Orca state in one remote round trip (#29059, #32918).
import { createHash } from 'node:crypto'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { RELAY_REMOTE_DIR } from '../../ssh/remote-exec/remote-frame-protocol'
import { ORCAD_ACTIVATION_FILENAME } from '../activation/orcad-activation-record'
import { parseDarwinPlatformUuid } from '../../persistence/profile-state/profile-state-access-identity'
import {
  normalizeRemoteHome,
  validateRemoteHome,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'

export const ORCAD_MACHINE_CLAIM_FILENAME = 'orcad-machine.json'
export const ORCAD_MACHINE_HOMES_DIRNAME = 'hosts'
export const ORCAD_MACHINE_CLAIM_SCHEMA_VERSION = 1

const SECTION = '__ORCA_MACHINE_HOME_SECTION__'
const CLAIM_ABSENT = 'ABSENT'
const CLAIM_PRESENT = 'PRESENT'
const RECORD_MAX_BYTES = 4096
const ACCESS_DIRNAME = '.profile-state-access'
const INSTALLED = 'INSTALLED'
// Unknown filesystem types may be shared; recognize only proven local disk types.
const LOCAL_FILESYSTEM_TYPES = new Set([
  'ext2/ext3',
  'ext4',
  'xfs',
  'btrfs',
  'zfs',
  'bcachefs',
  'f2fs',
  'jfs',
  'reiserfs',
  'nilfs',
  'tmpfs',
  'ramfs',
  'overlayfs',
  'ecryptfs',
  'msdos',
  'vfat',
  'exfat',
  'hfsplus'
])

export type OrcadMachineIdentity = {
  /** Path-safe hash; raw machine identity is not persisted in the claim. */
  key: string
  /** Separates Linux machines cloned with one machine-id; null when the hostname is unknown or on macOS. */
  cloneKey: string | null
  /** Match the identity recorded by profile-state owners. */
  machineIdentity: string
  hostname: string | null
}

export type OrcadMachineClaimRead =
  | { state: 'absent' }
  | { state: 'present'; machineKey: string; hostname: string | null }
  | { state: 'unreadable'; reason: string }

export type OrcadMachineHomeProbe = {
  loginHome: string
  identity: OrcadMachineIdentity | null
  claim: OrcadMachineClaimRead
  /** Include live and crashed owners when attributing shared-home state. */
  dataRootOwners: readonly OrcadDataRootOwner[]
  /** Machine-home owner hostnames; null for homes made before they were recorded. */
  machineHomes: ReadonlyMap<string, string | null>
  loginHomeInstalled: boolean
  /** Local disks cannot belong to another machine's live server. */
  homeOnLocalDisk: boolean
}

export type OrcadDataRootOwner = {
  /** Data root directory name, `.orca` or a machine home's `.orca-<key8>`. */
  root: string
  host: string | null
  machineIdentity: string | null
}

/** Probe home ownership once, using the same machine identity sources as profile-state access. */
export function orcadMachineHomeProbeCommand(host: RemoteHostPlatform): string {
  const claim = `"$HOME"/${quotePosixShell(`${RELAY_REMOTE_DIR}/${ORCAD_MACHINE_CLAIM_FILENAME}`)}`
  const homes = `"$HOME"/${quotePosixShell(`${RELAY_REMOTE_DIR}/${ORCAD_MACHINE_HOMES_DIRNAME}`)}`
  const activation = `"$HOME"/${quotePosixShell(`${RELAY_REMOTE_DIR}/${ORCAD_ACTIVATION_FILENAME}`)}`
  return [
    `printf '%s\\n' "$HOME"; echo ${SECTION};`,
    host.os === 'darwin'
      ? // Try PATH first for relocated host tools before the standard macOS location.
        '{ ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null ||' +
        ' /usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null; } | grep IOPlatformUUID;'
      : 'cat /etc/machine-id 2>/dev/null;',
    `echo; echo ${SECTION}; uname -n 2>/dev/null; echo; echo ${SECTION};`,
    // Full disks can leave an empty claim; publication can replace it.
    `if { [ ! -e ${claim} ] && [ ! -L ${claim} ]; } || { [ -f ${claim} ] && [ ! -s ${claim} ]; };`,
    `then echo ${CLAIM_ABSENT};`,
    `elif [ -f ${claim} ]; then echo ${CLAIM_PRESENT}; head -c ${RECORD_MAX_BYTES} ${claim}; echo;`,
    `else echo UNREADABLE; fi; echo ${SECTION};`,
    // Machine-home data roots too: a clone sharing this machine-id may already run in one.
    `for r in "$HOME"/.orca "$HOME"/.orca-????????; do a="$r"/${quotePosixShell(ACCESS_DIRNAME)};`,
    `for f in "$a"/participants/*/*.owner "$a"/maintenance/*.owner; do`,
    `[ -f "$f" ] && { printf '%s ' "\${r##*/}"; head -c ${RECORD_MAX_BYTES} "$f"; echo; }; done; done; echo ${SECTION};`,
    `for d in ${homes}/*; do [ -d "$d" ] && { printf '%s ' "\${d##*/}";`,
    `head -c ${RECORD_MAX_BYTES} "$d"/${quotePosixShell(ORCAD_MACHINE_CLAIM_FILENAME)} 2>/dev/null; echo; }; done; echo ${SECTION};`,
    `[ -e ${activation} ] && echo ${INSTALLED}; echo ${SECTION};`,
    // BSD stat -f has different semantics; macOS uses df device source instead.
    host.os === 'darwin' ? '' : `stat -f -c %T "$HOME" 2>/dev/null; echo ${SECTION};`,
    `df -P "$HOME" 2>/dev/null | tail -n 1; true`
  ].join(' ')
}

export function parseOrcadMachineHomeProbe(
  output: string,
  host: RemoteHostPlatform
): OrcadMachineHomeProbe {
  const sections = output.split(new RegExp(`^${SECTION}$`, 'mu'))
  if (sections.length !== (host.os === 'darwin' ? 8 : 9)) {
    throw new Error('orcad machine-home probe returned no verifiable answer')
  }
  const [homeRaw, machineRaw, hostnameRaw, claimRaw, ownersRaw, homesRaw, installedRaw] = sections
  const filesystemType = host.os === 'darwin' ? '' : sections[7].trim()
  const dfSource = sections.at(-1)?.trim().split(/\s+/u)[0] ?? ''
  const loginHome = normalizeRemoteHome(homeRaw, host)
  if (!validateRemoteHome(loginHome, host)) {
    throw new Error(`Remote home is not a valid path: ${loginHome.slice(0, 100)}`)
  }
  return {
    loginHome,
    identity: orcadMachineIdentity(host, machineRaw.trim(), hostnameRaw.trim()),
    claim: parseClaimSection(claimRaw.trim()),
    dataRootOwners: ownersRaw
      .split('\n')
      .map((line) => parseOwnerLine(line.trim()))
      .filter((owner) => owner !== null),
    machineHomes: new Map(
      homesRaw
        .split('\n')
        .map((line) => /^([a-f0-9]{16})(?: (.*))?$/u.exec(line.trim()))
        .filter((match) => match !== null)
        .map(([, key, marker]): [string, string | null] => {
          const read = marker ? parseOrcadMachineClaim(marker) : null
          return [key, read?.state === 'present' && read.machineKey === key ? read.hostname : null]
        })
    ),
    loginHomeInstalled: installedRaw.trim() === INSTALLED,
    // Without a filesystem type, only a device source proves local storage.
    homeOnLocalDisk: filesystemType
      ? LOCAL_FILESYSTEM_TYPES.has(filesystemType)
      : dfSource.startsWith('/dev/')
  }
}

/** Prefer stable Linux machine-id or macOS hardware UUID over hostnames; missing identity retains login-home fallback. */
export function orcadMachineIdentity(
  host: RemoteHostPlatform,
  machineRaw: string,
  hostnameRaw: string
): OrcadMachineIdentity | null {
  const machineIdentity =
    host.os === 'darwin'
      ? parseDarwinPlatformUuid(machineRaw)
      : /^[a-f0-9]{32}$/u.test(machineRaw) && !/^0+$/u.test(machineRaw)
        ? machineRaw
        : null
  if (!machineIdentity) {
    return null
  }
  const hostname = validHostname(hostnameRaw)
  return {
    key: machineKeyOf(`${host.os}:${machineIdentity}`),
    // macOS hostnames follow the network, and its hardware UUID is not cloned with disk images.
    cloneKey:
      hostname && host.os !== 'darwin'
        ? machineKeyOf(`${host.os}:${machineIdentity}:${hostname}`)
        : null,
    machineIdentity,
    hostname
  }
}

function machineKeyOf(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

function validHostname(raw: unknown): string | null {
  return typeof raw === 'string' && /^[\x21-\x7e]{1,255}$/u.test(raw) ? raw : null
}

function parseClaimSection(raw: string): OrcadMachineClaimRead {
  if (raw === CLAIM_ABSENT) {
    return { state: 'absent' }
  }
  if (!raw.startsWith(CLAIM_PRESENT)) {
    return { state: 'unreadable', reason: 'the claim is not a regular file' }
  }
  return parseOrcadMachineClaim(raw.slice(CLAIM_PRESENT.length).trim())
}

export function parseOrcadMachineClaim(raw: string): OrcadMachineClaimRead {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: 'unreadable', reason: 'the claim is not JSON' }
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'schemaVersion' in parsed &&
    parsed.schemaVersion === ORCAD_MACHINE_CLAIM_SCHEMA_VERSION &&
    'machineKey' in parsed &&
    typeof parsed.machineKey === 'string' &&
    /^[a-f0-9]{16}$/u.test(parsed.machineKey)
  ) {
    return {
      state: 'present',
      machineKey: parsed.machineKey,
      hostname: 'hostname' in parsed ? validHostname(parsed.hostname) : null
    }
  }
  return { state: 'unreadable', reason: 'the claim has an unknown shape' }
}

function parseOwnerLine(line: string): OrcadDataRootOwner | null {
  const match = /^(\.orca(?:-[a-f0-9]{8})?) (\{.*)$/u.exec(line)
  if (!match) {
    return null
  }
  try {
    const owner: unknown = JSON.parse(match[2])
    if (typeof owner !== 'object' || owner === null) {
      return null
    }
    return {
      root: match[1],
      host: 'host' in owner && typeof owner.host === 'string' ? owner.host : null,
      machineIdentity:
        'machineIdentity' in owner && typeof owner.machineIdentity === 'string'
          ? owner.machineIdentity
          : null
    }
  } catch {
    // Malformed owner records cannot prove a foreign machine owns the home.
    return null
  }
}

/** Record which machine took a home, so a clone sharing its machine-id can tell it apart. */
export function orcadMachineOwnerRecord(machineKey: string, hostname: string | null): string {
  return JSON.stringify({
    schemaVersion: ORCAD_MACHINE_CLAIM_SCHEMA_VERSION,
    machineKey,
    ...(hostname ? { hostname } : {})
  })
}
