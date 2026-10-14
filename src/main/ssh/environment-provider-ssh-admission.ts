import type { SshTarget } from '../../shared/ssh-types'
import { pluginEnvironmentSshBindingSchema } from '../../shared/plugins/plugin-environment-ssh-binding'

export type EnvironmentProviderSshLease = { isCurrent(): boolean; signal: AbortSignal }
let authorize: ((target: SshTarget) => Promise<EnvironmentProviderSshLease>) | null = null

export function setEnvironmentProviderSshAuthorizer(value: typeof authorize): void {
  authorize = value
}

/** Every dial must encounter the host-owned provider record; missing support never removes the fence. */
export async function admitEnvironmentProviderSshTarget(
  target: SshTarget
): Promise<EnvironmentProviderSshLease | null> {
  if (target.environmentProvider === undefined) {
    return null
  }
  pluginEnvironmentSshBindingSchema.parse(target.environmentProvider)
  const current = authorize
  if (!current) {
    throw new Error('Environment provider SSH admission is unavailable on this host')
  }
  const lease = await current(structuredClone(target))
  if (current !== authorize || lease.signal.aborted || !lease.isCurrent()) {
    throw new Error('Environment provider SSH authorization changed')
  }
  return lease
}

export function environmentProviderSshAuthorizerAvailable(): boolean {
  return authorize !== null
}
