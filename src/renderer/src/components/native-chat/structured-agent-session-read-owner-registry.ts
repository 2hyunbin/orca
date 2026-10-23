import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { StructuredAgentSessionReadOwner } from './structured-agent-session-read-owner'

let owners = new Map<string, StructuredAgentSessionReadOwner>()
export function structuredReadOwnerKey(sessionId: string, target: RuntimeClientTarget): string {
  return `${target.kind === 'local' ? 'local' : `environment:${target.environmentId}`}:${sessionId}`
}
export function findStructuredAgentSessionReadOwner(
  sessionId: string,
  target: RuntimeClientTarget
): StructuredAgentSessionReadOwner | undefined {
  return owners.get(structuredReadOwnerKey(sessionId, target))
}
type PreparedReadRetirement = {
  owners: Map<string, StructuredAgentSessionReadOwner>
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
  const prepared = previous ?? { owners: new Map(owners), effects: [] }
  const key = structuredReadOwnerKey(sessionId, target)
  const owner = prepared.owners.get(key)
  prepared.owners.delete(key)
  if (owner) {
    prepared.effects.push(() => disposeReadOwner(owner))
  }
  return prepared
}
export function installStructuredReadRetirement(prepared: PreparedReadRetirement): void {
  owners = prepared.owners
}
/** A closed chat no longer needs an unmounted create page or an active reader. */
export function retireStructuredAgentSessionReadOwner(
  sessionId: string,
  target: RuntimeClientTarget
): void {
  const key = structuredReadOwnerKey(sessionId, target)
  const owner = owners.get(key)
  owners.delete(key)
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
): void {
  if (!owners.has(key)) {
    owners.set(key, owner)
  }
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
