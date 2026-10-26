/**
 * A WSL bridge pane's process exit, when its whole distro is gone (`wsl --terminate`, a shutdown
 * or a crash), is host loss, not the shell exiting: like a daemon crash, the pane keeps its tab
 * and history and cold-restores later. `wsl.exe` reports such an exit as an ordinary code (1),
 * so only the running list tells it from a shell's own `exit`.
 */
import {
  readConfirmedRunningWslDistros,
  type WslRunningDistrosRead
} from '../wsl-background-distro-gate'

/** The code a synthetic host-loss exit carries, as after a daemon crash. */
export const WSL_DISTRO_LOSS_EXIT_CODE = -1

// The probe's own wsl.exe timeout bounds it already; this bounds a hung settle as well.
const WSL_EXIT_CHECK_TIMEOUT_MS = 8_000

export type ReadRunningWslDistros = () => Promise<WslRunningDistrosRead>

/**
 * True only when the running list is confirmed and the distro is not in it. The probe is the
 * shared, coalesced `wsl --list --running` (it never boots), so a terminate that exits many panes
 * at once costs one spawn. Unavailable or late means unchanged: the exit stays an exit.
 */
export async function isWslBridgeDistroLost(
  distro: string,
  readRunning: ReadRunningWslDistros = readConfirmedRunningWslDistros,
  timeoutMs = WSL_EXIT_CHECK_TIMEOUT_MS
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<WslRunningDistrosRead>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'unavailable' }), timeoutMs)
  })
  try {
    const running = await Promise.race([
      readRunning().catch((): WslRunningDistrosRead => ({ status: 'unavailable' })),
      timedOut
    ])
    const key = distro.trim().toLowerCase()
    return (
      running.status === 'confirmed' &&
      !running.distros.some((candidate) => candidate.trim().toLowerCase() === key)
    )
  } finally {
    clearTimeout(timer)
  }
}
