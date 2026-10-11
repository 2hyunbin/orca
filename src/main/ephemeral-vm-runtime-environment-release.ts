import { removeManagedOrcadEnvironment } from '../shared/runtime-environment-managed-orcad-store'
import { listEnvironments, removeEnvironment } from '../shared/runtime-environment-store'

/** Forgets the server a destroyed VM ran; a managed one's tunnel would otherwise keep redialing. */
export async function releaseEphemeralVmRuntimeEnvironment(
  userDataPath: string,
  environmentId: string
): Promise<void> {
  const environment = listEnvironments(userDataPath).find((entry) => entry.id === environmentId)
  if (!environment) {
    return
  }
  if (!environment.orcadDeployment) {
    removeEnvironment(userDataPath, environmentId)
    return
  }
  const { closeOrcadManagedTunnel } = await import('./ssh/orcad-managed-tunnel')
  await closeOrcadManagedTunnel(environmentId).catch(() => undefined)
  removeManagedOrcadEnvironment(userDataPath, environmentId)
}
