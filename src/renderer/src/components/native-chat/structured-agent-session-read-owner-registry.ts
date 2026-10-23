import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { StructuredAgentSessionReadOwner } from './structured-agent-session-read-owner'

const owners = new Map<string, StructuredAgentSessionReadOwner>()
const retired = new WeakSet<StructuredAgentSessionReadOwner>()
export function structuredReadOwnerKey(sessionId: string, target: RuntimeClientTarget): string {
  return `${target.kind === 'local' ? 'local' : `environment:${target.environmentId}`}:${sessionId}`
}
export function findStructuredAgentSessionReadOwner(
  sessionId: string,
  target: RuntimeClientTarget
): StructuredAgentSessionReadOwner | undefined {
  return owners.get(structuredReadOwnerKey(sessionId, target))
}
type ReadRetirement = { owner: StructuredAgentSessionReadOwner | undefined; detached: boolean }
type PreparedReadRetirement = {
  retirements: Map<string, ReadRetirement>
  effects: (() => void)[]
}
function disposeReadOwner(owner: StructuredAgentSessionReadOwner | undefined): void {
  try {
    owner?.dispose()
  } catch (error) {
    console.warn('[native-chat] retiring a conversation reader failed', error)
  }
}
export function prepareStructuredReadRetirement(
  previous: PreparedReadRetirement | null,
  sessionId: string,
  target: RuntimeClientTarget
): PreparedReadRetirement {
  const prepared = previous ?? { retirements: new Map(), effects: [] }
  const key = structuredReadOwnerKey(sessionId, target)
  if (!prepared.retirements.has(key)) {
    const retirement = { owner: owners.get(key), detached: false }
    prepared.retirements.set(key, retirement)
    prepared.effects.push(() => {
      if (retirement.detached) {
        disposeReadOwner(retirement.owner)
      }
    })
  }
  return prepared
}
export function installStructuredReadRetirement(prepared: PreparedReadRetirement): void {
  for (const [key, retirement] of prepared.retirements) {
    if (retirement.owner && owners.get(key) === retirement.owner) {
      owners.delete(key)
      retired.add(retirement.owner)
      retirement.detached = true
    }
  }
}
/** A closed chat no longer needs an unmounted create page or an active reader. */
export function retireStructuredAgentSessionReadOwner(
  sessionId: string,
  target: RuntimeClientTarget
): void {
  const key = structuredReadOwnerKey(sessionId, target)
  const owner = owners.get(key)
  owners.delete(key)
  if (owner) {
    retired.add(owner)
  }
  disposeReadOwner(owner)
}
export function getOrCreateStructuredReadOwner(
  key: string,
  create: () => StructuredAgentSessionReadOwner
): StructuredAgentSessionReadOwner {
  const existing = owners.get(key)
  if (existing) {
    return existing
  }
  const owner = create()
  owners.set(key, owner)
  return owner
}
/** A held owner names its key again once its last holders released it, never over a live one. */
export function adoptStructuredReadOwner(
  key: string,
  owner: StructuredAgentSessionReadOwner
): boolean {
  if (retired.has(owner)) {
    return false
  }
  if (!owners.has(key)) {
    owners.set(key, owner)
  }
  return true
}
export function forgetStructuredReadOwner(
  key: string,
  owner: StructuredAgentSessionReadOwner
): void {
  if (owners.get(key) === owner) {
    owners.delete(key)
  }
}
export function resetStructuredAgentSessionReadOwnersForTests(): void {
  for (const owner of owners.values()) {
    owner.dispose()
  }
  owners.clear()
}
