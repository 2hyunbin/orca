// Windows host-script paths bypass these POSIX-only command builders.
import { isWindowsRemoteHost, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

export class OrcadRemoteLaunchUnsupportedError extends Error {
  readonly code = 'orcad_remote_launch_unsupported_host'
  constructor(hostLabel: string) {
    super(
      `This orcad command does not run on a ${hostLabel} host. The install transaction is ` +
        'host-agnostic, but this step is a POSIX command with a separate Windows path.'
    )
    this.name = 'OrcadRemoteLaunchUnsupportedError'
  }
}

export function assertPosixOrcadHost(host: RemoteHostPlatform): void {
  if (isWindowsRemoteHost(host)) {
    throw new OrcadRemoteLaunchUnsupportedError('Windows')
  }
}

/** Candidate stdout containing readiness; bounded below even if other output follows. */
export const ORCAD_READINESS_FILENAME = '.orcad-readiness'
export const ORCAD_LOG_FILENAME = 'orcad.log'
// Candidate stdout is untrusted in size; never read runaway output whole.
export const ORCAD_READINESS_MAX_BYTES = 256 * 1024

export const ORCAD_PID_FILENAME = '.orcad-pid'
/** Windows pairs PID with creation time because PID reuse alone cannot identify the process. */
export const ORCAD_WINDOWS_PROCESS_FILENAME = '.orcad-process.json'

/** kill -0 includes zombies; ps excludes them, while missing ps evidence conservatively retains the process. */
export function posixProcessAliveShellFunction(
  options: { refuseUnverifiable?: boolean } = {}
): string {
  // Permission failures cannot prove exit for destructive lifecycle steps.
  const probe = options.refuseUnverifiable
    ? 'probe_error=$(LC_ALL=C kill -0 "$1" 2>&1) || { ' +
      'case "$probe_error" in *"No such process"*) return 1;; ' +
      '*) echo UNKNOWN; exit 0;; esac; }; '
    : 'kill -0 "$1" 2>/dev/null || return 1; '
  return (
    `orcad_alive() { ${probe}` +
    'case "$(ps -o stat= -p "$1" 2>/dev/null)" in Z*) return 1;; esac; return 0; };'
  )
}
