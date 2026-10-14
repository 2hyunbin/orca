import type { DeviceScope } from '../device-registry'
import { MANAGED_WORKSPACE_DISCOVERY_CAPABILITY } from '../../../shared/managed-workspace-discovery-contract'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Publish optional composition only when this paired runtime can actually service it. */
export function injectRuntimeStatusDeviceScope(
  response: string,
  scope: DeviceScope,
  discovery: boolean
): string {
  try {
    const parsed: unknown = JSON.parse(response)
    if (!record(parsed) || parsed.ok !== true || !record(parsed.result)) {
      return response
    }
    const capabilities = Array.isArray(parsed.result.capabilities)
      ? parsed.result.capabilities.filter(
          (item): item is string =>
            typeof item === 'string' && item !== MANAGED_WORKSPACE_DISCOVERY_CAPABILITY
        )
      : []
    return JSON.stringify({
      ...parsed,
      result: {
        ...parsed.result,
        deviceScope: scope,
        ...(discovery
          ? { capabilities: [...capabilities, MANAGED_WORKSPACE_DISCOVERY_CAPABILITY] }
          : Array.isArray(parsed.result.capabilities)
            ? { capabilities }
            : {})
      }
    })
  } catch {
    return response
  }
}
