import { uptime } from 'node:os'
import { readBootIdentity } from '../../agent-hooks/managed-hook-owner-identity'

/** A later boot by more than this; clock steps and uptime rounding stay under it. */
const LATER_BOOT_MARGIN_MS = 60_000

/** The execution host's boot: its id where the OS has one, and the derived boot time everywhere. */
export async function readSwitchHostBoot(): Promise<string> {
  return `${(await readBootIdentity()) ?? ''}@${Math.round(Date.now() - uptime() * 1000)}`
}

const parse = (boot: string): [string, number] => {
  const at = boot.lastIndexOf('@')
  return at === -1 ? ['', Number.NaN] : [boot.slice(0, at), Number(boot.slice(at + 1))]
}

/** A later boot proves every process of the saved one gone; an unreadable value never does.
 *  Windows Fast Startup keeps uptime across a shutdown, so that boot reads as the same one. */
export function isLaterSwitchHostBoot(saved: string, current: string): boolean {
  const [savedId, savedAt] = parse(saved)
  const [id, at] = parse(current)
  return savedId && id ? savedId !== id : at - savedAt > LATER_BOOT_MARGIN_MS
}
