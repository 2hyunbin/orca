import {
  managedRuntimeGatewayPath,
  parseManagedRuntimeGatewayRoute
} from './managed-runtime-gateway-contract'

const PREFIX = 'orca-gateway-v1:'
const MAX_CREDENTIAL_BYTES = 2048

/** Old peers cannot mistake this audience-bound credential for an ordinary paired bearer. */
export function managedWorkspaceGatewayCredential(
  parentToken: string,
  environmentId: string,
  generation: number
): string {
  if (!parentToken || parentToken.length > 256) {
    throw new Error('Invalid controller credential')
  }
  const route = managedRuntimeGatewayPath(environmentId, generation)
  return PREFIX + Buffer.from(JSON.stringify({ route, parentToken }), 'utf8').toString('base64url')
}

export function parseManagedWorkspaceGatewayCredential(token: string): {
  parentToken: string
  environmentId: string
  targetGeneration: number
} | null {
  if (!token.startsWith(PREFIX) || token.length > MAX_CREDENTIAL_BYTES) {
    return null
  }
  try {
    const encoded = token.slice(PREFIX.length)
    if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
      return null
    }
    const bytes = Buffer.from(encoded, 'base64url')
    if (bytes.toString('base64url') !== encoded) {
      return null
    }
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !('route' in value) ||
      typeof value.route !== 'string' ||
      !('parentToken' in value) ||
      typeof value.parentToken !== 'string' ||
      !value.parentToken ||
      value.parentToken.length > 256 ||
      Object.keys(value).length !== 2
    ) {
      return null
    }
    const route = parseManagedRuntimeGatewayRoute(value.route)
    if (route.kind !== 'managed') {
      return null
    }
    return {
      parentToken: value.parentToken,
      environmentId: route.environmentId,
      targetGeneration: route.targetGeneration
    }
  } catch {
    return null
  }
}
