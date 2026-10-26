// Restrict keys to fixed enums before validation so untrusted payloads cannot grow session state.
export function workspaceDiscoveryObservationKey(name: string, props: unknown): string | null {
  if (name === 'workspace_discovery_eligible') {
    return name
  }
  if (!props || typeof props !== 'object' || !('surface' in props)) {
    return null
  }
  const surface = props.surface
  if (surface !== 'suggestion' && surface !== 'manage') {
    return null
  }
  if (name === 'workspace_discovery_shown') {
    return `${name}:${surface}`
  }
  if (!('action' in props)) {
    return null
  }
  const action = props.action
  return action === 'reviewed' || action === 'import_completed' || action === 'dismissed'
    ? `${name}:${surface}:${action}`
    : null
}
