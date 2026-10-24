import { vi } from 'vitest'
import * as sourceBinding from './journal-selection-binding'
import * as structuralFold from './journal-structural-fold-step'
import * as rowSchema from './journal-row-schema'
import * as dependencies from './journal-legacy-dependencies'
import { JournalSelectionOrder } from './journal-selection-order'
import { JournalKeyedHeap } from './journal-keyed-heap'
import { WorkBucket } from './journal-work-bucket'
import * as classification from './journal-legacy-queue-classification'
import { JournalStructuralScratch } from './journal-structural-scratch'
import { LegacyQueueDisplayCorrections } from './journal-legacy-display-corrections'
import { JournalRestProjection } from './journal-rest-projection'
import { JournalSelectionGroups } from './journal-selection-groups'
import type { PopulationCost } from './journal-population-cost-test-support'

type Interceptor = (owner: object, args: unknown[], call: (args: unknown[]) => unknown) => unknown

/** Observe actual factory results of pre-defined subclasses; global Map cannot count these. */
export function instrumentPopulationWrappers(
  wrap: (owner: object, key: PropertyKey, intercept: Interceptor) => void,
  current: () => PopulationCost | undefined,
  label: (value: object, name: string) => void
): () => void {
  const observed = new WeakSet<object>()
  const prototypes = new WeakSet<object>()
  const spaces = new WeakMap<object, string>()
  const record = (value: object, kind: string) => {
    if (!observed.has(value)) {
      observed.add(value)
      const cost = current()
      if (cost) {
        cost.wrapperConstructors++
        cost.wrapperKinds[kind] = (cost.wrapperKinds[kind] ?? 0) + 1
      }
    }
  }
  const bind = sourceBinding.bindJournalSelection
  const bound = vi.spyOn(sourceBinding, 'bindJournalSelection').mockImplementation((state) => {
    const result = bind(state)
    for (const value of [result.items, result.submissions, result.aliases, result.queue.cards]) {
      record(value, 'SourceMap')
    }
    record(result.normalizedHandOffs, 'NormalizedSet')
    record(result.selection, 'JournalSelection')
    for (const name of ['groups', 'tree', 'order', 'storage'] as const) {
      record(result.selection[name], `JournalSelection:${name}`)
    }
    return result
  })
  wrap(JournalStructuralScratch.prototype, 'map', (_owner, args, call) => {
    const result = call(args)
    if (typeof result !== 'object' || result === null) {
      throw new Error('missing actual StructuralMap')
    }
    record(result, 'StructuralMap')
    label(result, String(args[0]))
    spaces.set(result, String(args[0]))
    const prototype = Object.getPrototypeOf(result)
    if (!prototypes.has(prototype)) {
      prototypes.add(prototype)
      for (const key of ['entries', 'keys', 'values', Symbol.iterator]) {
        wrap(prototype, key, (map, values, execute) => {
          const iterator = execute(values)
          if (
            !iterator ||
            typeof iterator !== 'object' ||
            !Reflect.has(iterator, Symbol.iterator)
          ) {
            throw new Error('missing structural iterator')
          }
          // SAFETY: these are the concrete checked StructuralMap iterable methods.
          const entries = iterator as Iterable<unknown>
          return (function* () {
            for (const value of entries) {
              const cost = current()
              if (cost) {
                cost.iteratorSteps++
                const name = spaces.get(map) ?? 'unlabelled-structural'
                if (name === 'settlements') {
                  cost.settlementIteratorSteps++
                }
                const entry = (cost.namespaces[name] ??= { points: 0, iterated: 0 })
                entry.iterated++
              }
              yield value
            }
          })()
        })
      }
    }
    return result
  })
  wrap(JournalStructuralScratch.prototype, 'set', (_owner, args, call) => {
    const result = call(args)
    if (typeof result !== 'object' || result === null) {
      throw new Error('missing actual StructuralSet')
    }
    record(result, 'StructuralSet')
    return result
  })
  wrap(LegacyQueueDisplayCorrections.prototype, 'displayState', (_owner, args, call) => {
    const result = call(args)
    if (result !== args[0] && typeof result === 'object' && result !== null) {
      for (const key of ['items', 'submissions', 'normalizedHandOffs']) {
        const value: unknown = Reflect.get(result, key)
        if (typeof value !== 'object' || value === null) {
          throw new Error('missing display collection')
        }
        record(value, key === 'normalizedHandOffs' ? 'JournalDisplaySet' : 'JournalDisplayOverlay')
      }
    }
    return result
  })
  wrap(LegacyQueueDisplayCorrections.prototype, 'correct', (_owner, args, call) => {
    const cost = current()
    if (cost) {
      cost.legacyDisplayEvaluations++
    }
    return call(args)
  })
  wrap(JournalRestProjection.prototype, 'observationStep', (_owner, args, call) => {
    const cost = current()
    if (cost) {
      cost.dependencySteps++
    }
    return call(args)
  })
  wrap(JournalStructuralScratch.prototype, 'cleanupStep', (_owner, args, call) => {
    const cost = current()
    if (cost) {
      cost.cleanupSteps++
    }
    return call(args)
  })
  wrap(JournalSelectionGroups.prototype, 'next', (_owner, args, call) => {
    const result = call(args)
    const cost = current()
    if (result && cost && args[0] === 'dirtyLegacy') {
      cost.legacyDirtyMembers++
    }
    return result
  })
  wrap(JournalSelectionGroups.prototype, 'values', (_owner, args, call) => {
    const result = call(args)
    if (!result || typeof result !== 'object' || !Reflect.has(result, Symbol.iterator)) {
      throw new Error('missing group iterator')
    }
    // SAFETY: the checked method is the concrete groups.values string iterator.
    const values = result as Iterable<string>
    return (function* () {
      for (const value of values) {
        const cost = current()
        if (cost && String(args[0]).startsWith('legacy')) {
          cost.legacyDependentYields++
        }
        yield value
      }
    })()
  })
  for (const method of ['update', 'top'] as const) {
    wrap(JournalKeyedHeap.prototype, method, (owner, args, call) => {
      record(owner, 'JournalKeyedHeap')
      return call(args)
    })
  }
  wrap(WorkBucket.prototype, 'update', (owner, args, call) => {
    record(owner, 'WorkBucket')
    return call(args)
  })
  wrap(JournalRestProjection.prototype, 'beginObservation', (owner, args, call) => {
    record(owner, 'JournalRestProjection')
    return call(args)
  })
  wrap(JournalSelectionOrder.prototype, 'maximum', (owner, args, call) => {
    record(owner, 'JournalSelectionOrder')
    return call(args)
  })
  const rawDependency = dependencies.legacyRawDependency
  const rawSignatures = vi
    .spyOn(dependencies, 'legacyRawDependency')
    .mockImplementation((...args) => {
      const result = rawDependency(...args)
      const cost = current()
      if (cost) {
        cost.sourceEncodedBytes += Buffer.from(result, 'base64').byteLength
      }
      return result
    })
  const attemptDependency = dependencies.legacyAttemptDependency
  const attemptSignatures = vi
    .spyOn(dependencies, 'legacyAttemptDependency')
    .mockImplementation((...args) => {
      const result = attemptDependency(...args)
      const cost = current()
      if (cost) {
        cost.sourceEncodedBytes += Buffer.from(result, 'base64').byteLength
      }
      return result
    })
  const parse = rowSchema.parseJournalRow
  const parsed = vi.spyOn(rowSchema, 'parseJournalRow').mockImplementation((source) => {
    const cost = current()
    if (cost) {
      cost.rawRowParses++
      cost.rawRowParseBytes += Buffer.byteLength(source)
    }
    return parse(source)
  })
  const step = structuralFold.stepStructuralJournalRow
  const stepped = vi
    .spyOn(structuralFold, 'stepStructuralJournalRow')
    .mockImplementation((...args) => {
      const cost = current()
      if (cost) {
        cost.structuralRowSteps++
      }
      return step(...args)
    })
  const classify = classification.legacyQueuedChange
  const classified = vi
    .spyOn(classification, 'legacyQueuedChange')
    .mockImplementation((...args) => {
      const cost = current()
      if (cost) {
        cost.legacyClassifications++
      }
      return classify(...args)
    })
  return () => {
    parsed.mockRestore()
    attemptSignatures.mockRestore()
    rawSignatures.mockRestore()
    classified.mockRestore()
    stepped.mockRestore()
    bound.mockRestore()
  }
}
