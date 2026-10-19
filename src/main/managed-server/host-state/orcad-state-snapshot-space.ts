/**
 * Room for the pre-activation snapshot (#30491).
 *
 * Only the snapshot the activation record names can ever be restored, yet every update used to
 * leave its own full copy of the state behind, and a failed capture its partial archive. On a
 * small or quota-limited home that grows until no update can snapshot at all. So the capture
 * prunes every other `pre-*` capture first, and the activation checks for room before it stops
 * the running server: a host that cannot fit the snapshot keeps that server.
 */
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { isWindowsRemoteHost, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import { ORCAD_SNAPSHOT_FAILURE, ORCAD_SNAPSHOT_MEMBERS } from './orcad-state-snapshot-members'
import { dfAvailableKb, formatKb } from './remote-filesystem-space'

const SPACE_MARKER = 'SNAPSHOT_SPACE'
const CAPTURE_PREFIX = 'pre-'
// tar's headers and 10 KB records, plus room for the state to grow before the server stops.
const SPACE_FACTOR = 1.05
const SPACE_SLACK_KB = 1024

/**
 * Removes every `pre-*` capture under `snapshotsRoot` except `keep`. Never a rollback rescue:
 * that holds the newer build's state, which nothing else does.
 */
export function pruneOrcadSnapshotsScript(snapshotsRoot: string, keep: readonly string[]): string {
  return [
    `for old in ${quotePosixShell(snapshotsRoot)}/${CAPTURE_PREFIX}*; do [ -d "$old" ] || continue;`,
    `case "\${old##*/}" in (${prunePatterns(keep)}) ;; (*) rm -rf "$old";; esac; done;`
  ].join(' ')
}

function prunePatterns(keep: readonly string[]): string {
  // Quoted, so `+` and `.` in a version match only themselves; `''` keeps nothing. Callers wrap
  // these in `(...)`: bash 3.2 misparses a bare `pat)` inside `$(...)`.
  return keep.length > 0 ? keep.map(quotePosixShell).join('|') : "''"
}

/**
 * Prints the KB the members occupy, the KB a prune would reclaim, and the `df -Pk` line for
 * `baseDir`. Read-only, so it can run before anything stops. Null on Windows (not measured).
 */
export function orcadSnapshotSpaceCommand(
  host: RemoteHostPlatform,
  userDataDir: string,
  snapshotsRoot: string,
  baseDir: string,
  keep: readonly string[]
): string | null {
  if (isWindowsRemoteHost(host)) {
    return null
  }
  const root = quotePosixShell(userDataDir)
  const members = ORCAD_SNAPSHOT_MEMBERS.map((member) => `${root}/${quotePosixShell(member)}`)
  const sum = `awk '{ total += $1 } END { print total + 0 }'`
  return [
    `need=$(du -sk ${members.join(' ')} 2>/dev/null | ${sum});`,
    `reclaim=$(for old in ${quotePosixShell(snapshotsRoot)}/${CAPTURE_PREFIX}*; do [ -d "$old" ] || continue;`,
    `case "\${old##*/}" in (${prunePatterns(keep)}) ;; (*) du -sk "$old" 2>/dev/null;; esac; done | ${sum});`,
    `echo "${SPACE_MARKER} $need $reclaim $(df -Pk ${quotePosixShell(baseDir)} 2>/dev/null | tail -n 1)"`
  ].join(' ')
}

export type OrcadSnapshotSpace = { neededKb: number; availableKb: number }

/** Null when the answer is missing or unreadable: the capture itself still decides. */
export function parseOrcadSnapshotSpace(output: string): OrcadSnapshotSpace | null {
  const line = output
    .split('\n')
    .toReversed()
    .find((candidate) => candidate.startsWith(`${SPACE_MARKER} `))
  const [, need, reclaim, ...df] = (line ?? '').trim().split(/\s+/u)
  const available = dfAvailableKb(df.join(' '))
  if (!need || !reclaim || !/^\d+$/u.test(need) || !/^\d+$/u.test(reclaim) || available === null) {
    return null
  }
  return { neededKb: Number(need), availableKb: available + Number(reclaim) }
}

/** The KB the host is short of a snapshot, or null when it fits (or there is nothing to keep). */
export function orcadSnapshotShortfallKb(space: OrcadSnapshotSpace | null): number | null {
  if (!space || space.neededKb === 0) {
    return null
  }
  const required = Math.ceil(space.neededKb * SPACE_FACTOR) + SPACE_SLACK_KB
  return space.availableKb >= required ? null : required - space.availableKb
}

export function orcadSnapshotShortfallMessage(
  space: OrcadSnapshotSpace,
  shortfallKb: number,
  where: { userDataDir: string; baseDir: string; fullVersion: string; active: string | null }
): string {
  const keeps = where.active
    ? `Orca keeps running the current server (${where.active}) until then.`
    : 'Orca cannot start its server on this host until then.'
  return (
    `Not enough disk space to snapshot ${where.userDataDir} before activating ` +
    `${where.fullVersion}: the filesystem holding ${where.baseDir} has ` +
    `${formatKb(space.availableKb)} free, and the snapshot needs about ` +
    `${formatKb(space.neededKb)}. Free at least ${formatKb(shortfallKb)} there (or raise the ` +
    `quota), then reconnect. ${keeps} Nothing was stopped.`
  )
}

/** The reason a POSIX capture printed before `FAILED`, if it printed one. */
export function orcadSnapshotFailureReason(output: string): string | null {
  const line = output
    .split('\n')
    .toReversed()
    .find((candidate) => candidate.startsWith(`${ORCAD_SNAPSHOT_FAILURE} `))
  const reason = line?.slice(ORCAD_SNAPSHOT_FAILURE.length).trim()
  return reason ? reason : null
}
