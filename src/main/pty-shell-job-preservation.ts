import type { DescendantSnapshot } from './pty-descendant-termination'

/** Graceful plain-shell close leaves nohup/disown jobs to the shell's SIGHUP, as any terminal does.
 *  Only background groups the shell itself leads qualify; agent-made groups (Codex MCP servers) are still swept. */
export function excludeShellBackgroundJobs(snapshot: DescendantSnapshot): DescendantSnapshot {
  const shellPid = snapshot.root?.pid
  const shellJobPgids = new Set(
    snapshot.descendants
      .filter(
        (row) =>
          row.pid === row.pgid &&
          row.ppid === shellPid &&
          row.pgid !== snapshot.rootPgid &&
          (row.tpgid ?? 0) > 0 &&
          row.pgid !== row.tpgid
      )
      .map((row) => row.pgid)
  )
  if (shellJobPgids.size === 0) {
    return snapshot
  }
  return {
    ...snapshot,
    descendants: snapshot.descendants.filter((row) => !shellJobPgids.has(row.pgid))
  }
}
