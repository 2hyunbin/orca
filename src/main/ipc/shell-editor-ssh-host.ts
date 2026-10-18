import { getAppEnvironment } from '../../shared/app-environment'
import { parseExecutionHostId, toSshExecutionHostId } from '../../shared/execution-host'
import { listEnvironments } from '../../shared/runtime-environment-store'
import {
  getRuntimeSshAccess,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'

export type ListRuntimeEnvironments = () => readonly Pick<
  KnownRuntimeEnvironment,
  'id' | 'orcadDeployment' | 'sshAccess'
>[]

export const listAppRuntimeEnvironments: ListRuntimeEnvironments = () =>
  listEnvironments(getAppEnvironment().getPath('userData'))

/** Whether `connectionId` is the SSH host that owns the path: that host, or the one its server runs on. */
export function isEditorSshHostForOwner(
  connectionId: string,
  ownerHostId: unknown,
  listRuntimeEnvironments: ListRuntimeEnvironments
): boolean {
  if (ownerHostId === toSshExecutionHostId(connectionId)) {
    return true
  }
  const owner = typeof ownerHostId === 'string' ? parseExecutionHostId(ownerHostId) : null
  if (owner?.kind !== 'runtime') {
    return false
  }
  let environments: ReturnType<ListRuntimeEnvironments>
  try {
    environments = listRuntimeEnvironments()
  } catch {
    return false
  }
  // Why main re-derives it: the renderer's claim alone must not point an editor at another host.
  const environment = environments.find((entry) => entry.id === owner.environmentId)
  return !!environment && getRuntimeSshAccess(environment)?.sshTargetId === connectionId
}
