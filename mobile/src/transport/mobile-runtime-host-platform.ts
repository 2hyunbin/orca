import { hostUnionArms } from '../../../src/shared/zod-salvage'

/** Node's own platform domain, pinned to @types/node's union: an arm added or dropped there fails tsc here. */
export const NODE_PLATFORM_NAMES = hostUnionArms<NodeJS.Platform>({
  aix: true,
  android: true,
  darwin: true,
  freebsd: true,
  haiku: true,
  linux: true,
  openbsd: true,
  sunos: true,
  win32: true,
  cygwin: true,
  netbsd: true
})

const NODE_PLATFORMS = new Set<NodeJS.Platform>(NODE_PLATFORM_NAMES)

/** The platform name a host reported, or null for anything this build does not know. */
export function toNodePlatform(value: unknown): NodeJS.Platform | null {
  return NODE_PLATFORM_NAMES.find((name) => name === value) ?? null
}

export function readMobileRuntimeHostPlatform(statusResult: unknown): NodeJS.Platform | null {
  const hostPlatform = (statusResult as { hostPlatform?: unknown } | null)?.hostPlatform
  return typeof hostPlatform === 'string' && NODE_PLATFORMS.has(hostPlatform as NodeJS.Platform)
    ? (hostPlatform as NodeJS.Platform)
    : null
}
