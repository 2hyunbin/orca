import { uptime } from 'node:os'
import { runProcess } from '@orca/process-host'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'
import { readBootIdentity } from '../../agent-hooks/managed-hook-owner-identity'

const WINDOWS_BOOT_KEY =
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters'

/** The OS's own boot counter or id; undefined when unreadable. Windows: one read-only reg.exe. */
async function readOsBootId(): Promise<string | undefined> {
  if (process.platform !== 'win32') {
    return readBootIdentity()
  }
  const result = await runProcess({
    program: windowsSystem32Binary('reg.exe'),
    args: ['query', WINDOWS_BOOT_KEY, '/v', 'BootId'],
    timeoutMs: 5_000
  }).catch(() => null)
  const id = result?.code === 0 ? /BootId\s+REG_DWORD\s+(0x[0-9a-f]+)/i.exec(result.stdout) : null
  return id ? `win:${id[1].toLowerCase()}` : undefined
}

/** Read at acceptance and on owner-loss recovery only: the boot id, and uptime at reading. */
export async function readSwitchHostBoot(): Promise<string> {
  return `${(await readOsBootId()) ?? ''}@${uptime()}`
}

const parse = (boot: string): [string, number] => {
  const at = boot.lastIndexOf('@')
  return at === -1 ? ['', Number.NaN] : [boot.slice(0, at), Number(boot.slice(at + 1))]
}

/** A later boot, from clock-free facts only: a different boot id, or uptime lower than it was
 *  (it only grows within a boot). macOS uptime is derived from the wall clock, so there only the
 *  id counts. Anything unreadable proves nothing. */
export function isLaterSwitchHostBoot(saved: string, current: string): boolean {
  const [savedId, savedUptime] = parse(saved)
  const [id, currentUptime] = parse(current)
  if (savedId && id) {
    return savedId !== id
  }
  return process.platform !== 'darwin' && currentUptime < savedUptime
}
