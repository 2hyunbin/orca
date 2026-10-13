import type { AppState } from '@/store/types'

export function pluginViewerRuntimeIdentity(
  state: Pick<AppState, 'runtimeEnvironments' | 'runtimeStatusByEnvironmentId'>,
  environmentId: string
): string | null {
  const environment = state.runtimeEnvironments.find((entry) => entry.id === environmentId)
  if (!environment) {
    return null
  }
  const entry = state.runtimeStatusByEnvironmentId.get(environmentId)
  const snapshot = entry?.snapshot
  if (
    snapshot &&
    (snapshot.environmentId !== environmentId ||
      snapshot.pairingRevision !== (environment.pairingRevision ?? environment.createdAt) ||
      snapshot.retired ||
      snapshot.verification === 'blocked')
  ) {
    return null
  }
  // A newly managed host's catalog can predate its first verified status publication.
  return entry?.status?.runtimeId ?? environment.runtimeId
}
