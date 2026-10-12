import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'

export function freshDaemonSpawnAdapter(
  options: PtySpawnOptions,
  current: DaemonPtyAdapter,
  others: readonly DaemonPtyAdapter[],
  owner: DaemonPtyAdapter | undefined
): DaemonPtyAdapter {
  if (owner) {
    return owner
  }
  if (!options.windowsRunAsAdministrator) {
    return current
  }
  const administrator = others.find((adapter) => adapter.windowsAdministrator === true)
  if (!administrator) {
    throw new Error('Administrator terminals are unavailable on this execution host.')
  }
  return administrator
}
