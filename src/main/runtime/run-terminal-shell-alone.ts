/**
 * Proof that a run terminal's shell is alone at its prompt, read from the execution host's own
 * process table. The daemon's shell-ownership flag cannot carry it: that flag turns 'shell' only
 * after a full-screen command exits, so a plain "command not found" or an agent that already
 * exited never sets it. Every failure to observe reads as unproven.
 */
import { confirmShellForegroundProcess } from '../providers/agent-foreground-process'
import { inspectSpawnFileChildProcessesFromRows } from '../daemon/pty-subprocess/spawn-file-child-processes'
import {
  getCommandTokenPathBasename,
  getFirstCommandToken
} from '../../shared/command-token-scanner'
import { getFreshProcessTableSnapshot } from '../../shared/process-table-snapshot-reader'
import { collectDescendantsFromIndex, getProcessTableIndex } from '../../shared/process-table-index'
import { isShellProcess } from '../../shared/shell-process-detection'
import type { TerminalProcessInspection } from '../../shared/terminal-process-inspection'

/** POSIX: the PTY's root shell owns the terminal's foreground group and nothing under it is stopped. */
export async function confirmRootShellAloneFromProcessTable(rootPid: number): Promise<boolean> {
  try {
    const root = getProcessTableIndex(await getFreshProcessTableSnapshot()).byPid.get(rootPid)
    const executable = root?.command.trim().split(/\s+/, 1)[0] ?? ''
    if (!isShellProcess(executable)) {
      return false
    }
    return await confirmShellForegroundProcess(rootPid, executable)
  } catch {
    return false
  }
}

/** Windows: the host's job-based child census found nothing under the shell. */
export function inspectionShowsShellAlone(inspection: TerminalProcessInspection | null): boolean {
  if (!inspection || inspection.verdict === 'unverifiable') {
    return false
  }
  return (
    inspection.childProcessEvidence === 'no-children' &&
    (inspection.foregroundProcess === null || isShellProcess(inspection.foregroundProcess))
  )
}

/**
 * POSIX: nothing but the PTY's shell and its launch wrapper (macOS `login`) lives in its tree,
 * background and stopped jobs included. A malformed capture proves nothing.
 */
export async function confirmRootShellHasNoChildrenFromProcessTable(
  rootPid: number
): Promise<boolean> {
  try {
    const rows = await getFreshProcessTableSnapshot(true)
    const index = getProcessTableIndex(rows)
    const root = index.byPid.get(rootPid)
    const shell = (root ? [root, ...collectDescendantsFromIndex(index, rootPid)] : [])
      .map((row) =>
        getCommandTokenPathBasename(getFirstCommandToken(row.command)).replace(/^-/, '')
      )
      .find(isShellProcess)
    return (
      shell !== undefined &&
      inspectSpawnFileChildProcessesFromRows(rows, rootPid, shell) === 'no-children'
    )
  } catch {
    return false
  }
}
