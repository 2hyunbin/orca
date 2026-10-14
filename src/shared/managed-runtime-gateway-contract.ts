import { z } from 'zod'

export const MANAGED_RUNTIME_GATEWAY_CAPABILITY = 'managedServer.workspace-gateway.v1' as const
export const MANAGED_RUNTIME_GATEWAY_PREFIX = '/_orca/managed/'

const EnvironmentIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      value.trim() === value &&
      value !== '.' &&
      value !== '..' &&
      !Array.from(value).some((character) => {
        const code = character.charCodeAt(0)
        return code < 32 || code === 127
      }),
    'Invalid managed environment identity'
  )
const GenerationSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

export const ManagedRuntimeGatewayDescriptorSchema = z.strictObject({
  version: z.literal(1),
  controllerRuntimeId: EnvironmentIdSchema,
  environmentId: EnvironmentIdSchema,
  runtimeId: EnvironmentIdSchema,
  sshTargetId: z.string().min(1).max(256),
  targetGeneration: GenerationSchema,
  name: z.string().min(1).max(200)
})
export type ManagedRuntimeGatewayDescriptor = z.infer<typeof ManagedRuntimeGatewayDescriptorSchema>

export function managedRuntimeGatewayPath(environmentId: string, targetGeneration: number): string {
  return `${MANAGED_RUNTIME_GATEWAY_PREFIX}${encodeURIComponent(EnvironmentIdSchema.parse(environmentId))}/${GenerationSchema.parse(targetGeneration)}`
}

export type ManagedRuntimeGatewayRoute =
  | { kind: 'root' }
  | { kind: 'invalid' }
  | { kind: 'managed'; environmentId: string; targetGeneration: number }

function isReservedManagedPath(pathname: string): boolean {
  // Decode valid ASCII escapes even when a later malformed escape makes full decoding fail.
  const namespace = pathname
    .replace(/%([0-7][0-9a-f])/giu, (_escape, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
    .replaceAll('\\', '/')
    .toLowerCase()
  return namespace === '/_orca/managed' || namespace.startsWith(MANAGED_RUNTIME_GATEWAY_PREFIX)
}

export function parseManagedRuntimeGatewayRoute(
  requestUrl: string | undefined
): ManagedRuntimeGatewayRoute {
  const raw = requestUrl ?? '/'
  const pathname = raw.split(/[?#]/u, 1)[0]
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return isReservedManagedPath(pathname) ? { kind: 'invalid' } : { kind: 'root' }
  }
  if (!isReservedManagedPath(decoded)) {
    return { kind: 'root' }
  }
  if (
    raw.length > 2048 ||
    raw !== pathname ||
    !pathname.startsWith(MANAGED_RUNTIME_GATEWAY_PREFIX)
  ) {
    return { kind: 'invalid' }
  }
  const parts = pathname.slice(MANAGED_RUNTIME_GATEWAY_PREFIX.length).split('/')
  if (parts.length !== 2 || !/^[1-9][0-9]{0,15}$/u.test(parts[1])) {
    return { kind: 'invalid' }
  }
  const environmentId = EnvironmentIdSchema.safeParse(decodeURIComponent(parts[0]))
  const targetGeneration = GenerationSchema.safeParse(Number(parts[1]))
  if (
    !environmentId.success ||
    !targetGeneration.success ||
    managedRuntimeGatewayPath(environmentId.data, targetGeneration.data) !== pathname
  ) {
    return { kind: 'invalid' }
  }
  return {
    kind: 'managed',
    environmentId: environmentId.data,
    targetGeneration: targetGeneration.data
  }
}

export function managedRuntimeGatewayEndpoint(
  controllerEndpoint: string,
  descriptor: ManagedRuntimeGatewayDescriptor,
  capabilities: readonly string[]
): string {
  const parsed = ManagedRuntimeGatewayDescriptorSchema.parse(descriptor)
  if (!capabilities.includes(MANAGED_RUNTIME_GATEWAY_CAPABILITY)) {
    throw new Error('The control host does not support managed workspace access')
  }
  const endpoint = new URL(controllerEndpoint)
  if (
    !['ws:', 'wss:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== '/'
  ) {
    throw new Error('The control host endpoint does not support this gateway route')
  }
  endpoint.pathname = managedRuntimeGatewayPath(parsed.environmentId, parsed.targetGeneration)
  return endpoint.href
}
