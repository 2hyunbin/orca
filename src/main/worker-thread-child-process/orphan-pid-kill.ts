/** Signals a child by pid; false when it is already gone. */
export function killOrphanByPid(pid: number, signal?: NodeJS.Signals | number): boolean {
  try {
    return process.kill(pid, signal)
  } catch {
    // ESRCH: it already exited.
    return false
  }
}
