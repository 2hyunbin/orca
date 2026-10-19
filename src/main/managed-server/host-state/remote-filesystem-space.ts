/** Free space on a POSIX host, read from `df -Pk` (GNU, BSD and BusyBox agree on its columns). */

/** The available-KB column of one `df -Pk` data line, or null when the line has none. */
export function dfAvailableKb(line: string | undefined): number | null {
  const available = line?.trim().split(/\s+/u)[3]
  return available && /^\d+$/u.test(available) ? Number(available) : null
}
