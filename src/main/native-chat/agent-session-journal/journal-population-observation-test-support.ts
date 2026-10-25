import type { JournalReducerState } from './journal-reducer'

export type PopulationCollection = Map<unknown, unknown> | Set<unknown>

export function populationSource(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'source' in value ? value.source : undefined
}

export function populationRestCollections(value: unknown): readonly (readonly [string, unknown])[] {
  if (typeof value !== 'object' || value === null) {
    throw new Error('missing actual rest projection')
  }
  return [
    ['requests', 'requests' in value ? value.requests : undefined],
    ['clears', 'clears' in value ? value.clears : undefined],
    ['cuts', 'cuts' in value ? value.cuts : undefined],
    ['cutAt', 'cutAt' in value ? value.cutAt : undefined],
    ['cutBuckets', 'cutBuckets' in value ? value.cutBuckets : undefined],
    ['predecessors', 'predecessors' in value ? value.predecessors : undefined],
    ['submissionWork', 'submissionWork' in value ? value.submissionWork : undefined],
    ['origins', 'origins' in value ? value.origins : undefined]
  ]
}

export function populationHeapCollections(value: unknown): readonly unknown[] {
  if (typeof value !== 'object' || value === null) {
    throw new Error('missing actual keyed heap')
  }
  return [
    'slots' in value ? value.slots : undefined,
    'positions' in value ? value.positions : undefined
  ]
}

type RestObserver = { observeOne(state: JournalReducerState, itemId: string): void }

function isRestObserver(value: unknown): value is RestObserver {
  return (
    typeof value === 'object' &&
    value !== null &&
    'observeOne' in value &&
    typeof value.observeOne === 'function'
  )
}

export function populationRestObserver(value: unknown): RestObserver {
  if (!isRestObserver(value)) {
    throw new Error('missing actual rest observation method')
  }
  return value
}

export type PopulationMapIterators = {
  entries(): Iterable<unknown>
  keys(): Iterable<unknown>
  values(): Iterable<unknown>
  [Symbol.iterator](): Iterable<unknown>
}

function isMapIterators(value: unknown): value is PopulationMapIterators {
  return (
    typeof value === 'object' &&
    value !== null &&
    'entries' in value &&
    typeof value.entries === 'function' &&
    'keys' in value &&
    typeof value.keys === 'function' &&
    'values' in value &&
    typeof value.values === 'function' &&
    Symbol.iterator in value &&
    typeof value[Symbol.iterator] === 'function'
  )
}

export function populationMapIterators(value: unknown): PopulationMapIterators {
  if (!isMapIterators(value)) {
    throw new Error('missing actual StructuralMap iterable methods')
  }
  return value
}

export function isPopulationIterable(value: unknown): value is Iterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.iterator in value &&
    typeof value[Symbol.iterator] === 'function'
  )
}
