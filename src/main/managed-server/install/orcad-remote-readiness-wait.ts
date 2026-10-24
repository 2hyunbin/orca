// Poll on the host to avoid repeated SSH execs and Windows EDR process-burst signals.
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import { ORCAD_READINESS_FILENAME, ORCAD_READINESS_MAX_BYTES } from './orcad-remote-host-support'
import {
  parseOrcadReadinessOutput,
  readOrcadReadinessCommand,
  type OrcadReadinessParse
} from './orcad-remote-launch'
import {
  orcadWindowsSlotOpCommand,
  readOrcadWindowsEncodedAnswer
} from './orcad-remote-windows-node'
import { ORCAD_WINDOWS_READINESS_MARKER } from '../host-state/orcad-windows-host-script'

// Stay below the 30-second exec timeout so a wait can answer before the channel expires.
export const ORCAD_READINESS_WAIT_MAX_SECONDS = 20

function posixReadinessWaitCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  waitSeconds: number
): string {
  const file = quotePosixShell(joinRemotePath(host, remoteInstallDir, ORCAD_READINESS_FILENAME))
  const read = `head -c ${ORCAD_READINESS_MAX_BYTES + 1} ${file} 2>/dev/null`
  return [
    // Fractional sleep is not POSIX; probe it once so polling stays fine-grained where it can.
    'if sleep 0.25 2>/dev/null; then orcad_readiness_wait_step=0.25;',
    'else orcad_readiness_wait_step=1; fi;',
    // Slow reads count toward the deadline; iteration counts can overrun the client exec timeout.
    `orcad_readiness_wait_end=$(($(date +%s) + ${waitSeconds}));`,
    'while [ "$(date +%s)" -lt "$orcad_readiness_wait_end" ]; do',
    `[ "$(${read} | wc -l)" -gt 0 ] && break;`,
    `[ "$(${read} | wc -c)" -gt ${ORCAD_READINESS_MAX_BYTES} ] && break;`,
    'sleep "$orcad_readiness_wait_step"; done;',
    `${read} || true`
  ].join(' ')
}

export function orcadReadinessWaitCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  waitSeconds: number
): string {
  const seconds = Math.max(0, Math.min(ORCAD_READINESS_WAIT_MAX_SECONDS, Math.ceil(waitSeconds)))
  if (!isWindowsRemoteHost(host)) {
    return posixReadinessWaitCommand(host, remoteInstallDir, seconds)
  }
  return orcadWindowsSlotOpCommand(host, remoteInstallDir, 'readiness-wait', [
    joinRemotePath(host, remoteInstallDir, ORCAD_READINESS_FILENAME),
    String(ORCAD_READINESS_MAX_BYTES),
    String(seconds)
  ])
}

export function parseOrcadReadinessWaitOutput(
  host: RemoteHostPlatform,
  output: string
): OrcadReadinessParse {
  return parseOrcadReadinessOutput(
    isWindowsRemoteHost(host)
      ? (readOrcadWindowsEncodedAnswer(output, ORCAD_WINDOWS_READINESS_MARKER) ?? '')
      : output
  )
}

export function readOrcadReadinessNowCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  // Windows has no head; the zero-wait host op reads the same bytes.
  return isWindowsRemoteHost(host)
    ? orcadReadinessWaitCommand(host, remoteInstallDir, 0)
    : readOrcadReadinessCommand(host, remoteInstallDir)
}
