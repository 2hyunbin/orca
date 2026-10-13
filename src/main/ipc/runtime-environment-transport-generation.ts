const generationByEnvironment = new Map<string, number>()
const MAX_TRACKED_ENVIRONMENTS = 512
let generationSequence = 0
let evictedGeneration = 0
const listenersByEnvironment = new Map<string, Set<() => void>>()

export function onRuntimeEnvironmentTransportChanged(
  environmentId: string,
  listener: () => void
): () => void {
  const listeners = listenersByEnvironment.get(environmentId) ?? new Set<() => void>()
  listeners.add(listener)
  listenersByEnvironment.set(environmentId, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      listenersByEnvironment.delete(environmentId)
    }
  }
}

export function getRuntimeEnvironmentTransportGeneration(environmentId: string): number {
  return generationByEnvironment.get(environmentId) ?? evictedGeneration
}

export function advanceRuntimeEnvironmentTransportGeneration(environmentId: string): void {
  const changed = new Set([environmentId])
  const generation = ++generationSequence
  generationByEnvironment.set(environmentId, generation)
  while (generationByEnvironment.size > MAX_TRACKED_ENVIRONMENTS) {
    const oldest = generationByEnvironment.keys().next()
    if (oldest.done) {
      break
    }
    evictedGeneration = Math.max(evictedGeneration, generationByEnvironment.get(oldest.value) ?? 0)
    generationByEnvironment.delete(oldest.value)
    changed.add(oldest.value)
  }
  for (const id of changed) {
    for (const listener of Array.from(listenersByEnvironment.get(id) ?? [])) {
      try {
        listener()
      } catch (error) {
        console.warn('[runtime-environments] transport retirement listener failed:', error)
      }
    }
  }
}

export function _getRuntimeEnvironmentTransportGenerationCacheSize(): number {
  return generationByEnvironment.size
}
