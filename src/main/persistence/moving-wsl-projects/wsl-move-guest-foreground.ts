/**
 * What a bridge WSL pane is running, read inside its distro. On Windows the pane's own process is
 * `wsl.exe`, which every live pane has, so the host process table cannot tell an idle shell from a
 * running program. Each guest process of a pane inherits `ORCA_PANE_KEY`; the pane is idle only
 * when its terminal's foreground process group holds nothing but shells.
 */
import { isShellProcess } from '../../../shared/shell-process-detection'

export type WslGuestPaneForeground = 'shell-idle' | 'process-running' | 'unverifiable'

export type WslGuestProcessRow = {
  pid: number
  pgrp: number
  /** The controlling terminal's foreground process group; -1 without a terminal. */
  tpgid: number
  paneKey: string | null
  comm: string
}

/**
 * One line per process with a controlling terminal: pid, pgrp, tpgid, comm and the pane key.
 * Tab-separated; fields are read after the last `)` because comm may contain spaces or parens.
 */
export const WSL_GUEST_PANE_PROCESS_SCRIPT = [
  'for d in /proc/[0-9]*; do',
  '  p=${d#/proc/}',
  '  s=$(cat "$d/stat" 2>/dev/null) || continue',
  '  r=${s##*) }',
  '  set -- $r',
  '  [ "$5" = 0 ] && continue',
  '  c=$(cat "$d/comm" 2>/dev/null)',
  `  k=$(tr '\\0' '\\n' < "$d/environ" 2>/dev/null | sed -n 's/^ORCA_PANE_KEY=//p' | head -n 1)`,
  `  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$p" "$3" "$6" "$c" "$k"`,
  'done'
].join('\n')

export function parseWslGuestPaneProcesses(stdout: string): WslGuestProcessRow[] {
  const rows: WslGuestProcessRow[] = []
  for (const line of stdout.split('\n')) {
    const [pid, pgrp, tpgid, comm, paneKey] = line.split('\t')
    const numbers = [pid, pgrp, tpgid].map((value) => Number(value))
    if (comm === undefined || numbers.some((value) => !Number.isInteger(value))) {
      continue
    }
    rows.push({
      pid: numbers[0],
      pgrp: numbers[1],
      tpgid: numbers[2],
      comm: comm.trim(),
      paneKey: paneKey?.trim() || null
    })
  }
  return rows
}

/** A pane with no guest process found is unverifiable, never idle. */
export function classifyWslGuestPaneForeground(
  rows: readonly WslGuestProcessRow[],
  paneKey: string
): WslGuestPaneForeground {
  const tagged = rows.filter((row) => row.paneKey === paneKey)
  const groups = new Set(tagged.map((row) => row.tpgid).filter((group) => group > 0))
  if (groups.size !== 1) {
    return 'unverifiable'
  }
  const [foregroundGroup] = groups
  // Untagged members count too: a program that cleared its environment is still the foreground.
  const members = rows.filter((row) => row.pgrp === foregroundGroup)
  if (members.length === 0) {
    return 'unverifiable'
  }
  return members.every((row) => isShellProcess(row.comm)) ? 'shell-idle' : 'process-running'
}
