import { populationMethodWrapper } from './journal-population-method-test-support'
import {
  isPopulationIterable,
  populationSource,
  populationRestCollections,
  populationRestObserver,
  type PopulationCollection
} from './journal-population-observation-test-support'
import type { JournalMutationSet } from './journal-mutation-set'
import { instrumentPopulationWrappers } from './journal-population-wrapper-test-support'
import { instrumentPopulationSql } from './journal-population-sql-test-support'
import { instrumentPopulationStaging } from './journal-population-stage-test-support'
import { JournalMutationMap } from './journal-mutation-map'
import { emptyPopulationCost, type PopulationCost } from './journal-population-cost-test-support'
export type { PopulationCost } from './journal-population-cost-test-support'
import { vi } from 'vitest'
import { JournalSelection } from './journal-selection'
import { JournalSelectionStorage } from './journal-selection-storage'
import { JournalRestProjection } from './journal-rest-projection'
import { WorkBucket } from './journal-work-bucket'
import type { JournalReducerState } from './journal-reducer'

/** Test-local instrumentation; counts execution and yielded inputs, not prepare calls alone. */
export class JournalPopulationMeter {
  private current?: PopulationCost
  private readonly names = new WeakMap<object, string>()
  private readonly constructedCOW = new WeakSet<object>()
  private readonly restores: (() => void)[] = []

  private readonly wrap = populationMethodWrapper(this.restores)

  constructor() {
    const recordCOW = <Key, Value>(
      value: JournalMutationMap<Key, Value> | JournalMutationSet<Key>
    ) => {
      if (!this.constructedCOW.has(value)) {
        this.constructedCOW.add(value)
        if (this.current) {
          this.current.cowConstructors++
        }
      }
    }
    this.restores.push(instrumentPopulationStaging(recordCOW, (state) => this.label(state)))
    const NativeMap = Map
    const NativeSet = Set
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This descriptor is the native Map size getter; reflection erases its numeric return/receiver types, and clear forwards the captured Map owner.
    const mapSize = Object.getOwnPropertyDescriptor(NativeMap.prototype, 'size')!.get as (
      this: PopulationCollection
    ) => number
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This descriptor is the native Set size getter; reflection erases its numeric return/receiver types, and clear forwards the captured Set owner.
    const setSize = Object.getOwnPropertyDescriptor(NativeSet.prototype, 'size')!.get as (
      this: PopulationCollection
    ) => number
    for (const method of ['get', 'has', 'set', 'delete'] as const) {
      this.wrap(NativeMap.prototype, method, (owner, args, call) => {
        this.point(owner)
        return call(args)
      })
    }
    for (const method of ['has', 'add', 'delete'] as const) {
      this.wrap(NativeSet.prototype, method, (owner, args, call) => {
        this.point(owner)
        return call(args)
      })
    }
    for (const [prototype, size] of [
      [NativeMap.prototype, mapSize],
      [NativeSet.prototype, setSize]
    ] as const) {
      for (const method of ['entries', 'keys', 'values', Symbol.iterator] as const) {
        this.wrap(prototype, method, (owner, args, call) => {
          const result = call(args)
          if (!isPopulationIterable(result)) {
            throw new Error('collection returned a non-iterator')
          }
          return this.iterate(result, owner)
        })
      }
      this.wrap(prototype, 'clear', (owner, args, call) => {
        if (this.current) {
          this.current.clears += size.call(owner)
        }
        return call(args)
      })
      this.wrap(prototype, 'forEach', (owner, args, call) => {
        const [callback, receiver] = args
        if (typeof callback !== 'function') {
          throw new Error('invalid collection callback')
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The checked native forEach callback receives its original value/key/collection tuple and thisArg; combining Map/Set prototypes loses that correlation.
        const invoke = callback as (
          this: unknown,
          value: unknown,
          key: unknown,
          collection: PopulationCollection
        ) => void
        return call([
          (...values: [unknown, unknown, PopulationCollection]) => {
            this.iterated(owner)
            invoke.apply(receiver, values)
          }
        ])
      })
    }
    const construct = <T>(input: Iterable<T>) => this.construct(input)
    const recordConstructor = () => {
      if (this.current) {
        this.current.constructors++
      }
    }
    class MeasuredMap<K, V> extends NativeMap<K, V> {
      constructor(input?: Iterable<readonly [K, V]> | null) {
        super(input ? construct(input) : input)
        recordConstructor()
      }
    }
    class MeasuredSet<T> extends NativeSet<T> {
      constructor(input?: Iterable<T> | null) {
        super(input ? construct(input) : input)
        recordConstructor()
      }
    }
    vi.stubGlobal('Map', MeasuredMap)
    vi.stubGlobal('Set', MeasuredSet)
    this.wrap(JournalSelectionStorage.prototype, 'map', (_owner, args, call) => {
      const result = call(args)
      if (typeof result === 'object' && result !== null && typeof args[0] === 'string') {
        this.names.set(result, args[0])
        if (result instanceof JournalMutationMap) {
          recordCOW(result)
        }
      }
      return result
    })
    this.wrap(JournalRestProjection.prototype, 'beginObservation', (owner, args, call) => {
      for (const [name, rows] of populationRestCollections(owner)) {
        if (!['requests', 'clears', 'cuts', 'cutAt', 'predecessors'].includes(name)) {
          continue
        }
        if (rows instanceof NativeMap) {
          this.names.set(rows, `rest:${name}`)
        }
      }
      return call(args)
    })
    this.wrap(WorkBucket.prototype, 'update', (owner, args, call) => {
      const rows = owner.entries
      if (rows instanceof NativeMap) {
        this.names.set(rows, 'workEntries')
      }
      return call(args)
    })
    this.wrap(
      populationRestObserver(JournalRestProjection.prototype),
      'observeOne',
      (_owner, args, call) => {
        const result = call(args)
        const state = args[0]
        if (this.current) {
          const selection = state.selection
          if (selection instanceof JournalSelection) {
            const signature = selection.storage
              .map<string, string>('restDependencies')
              .get(String(args[1]))
            this.current.sourceEncodedBytes += signature
              ? Buffer.from(signature, 'base64').byteLength
              : 0
          }
        }
        return result
      }
    )
    this.wrap(JournalSelection.prototype, 'submissionChanged', (owner, args, call) => {
      const result = call(args)
      if (this.current && args[1] !== undefined && owner instanceof JournalSelection) {
        const signature = owner.storage
          .map<string, { signature: string }>('submissionSources')
          .get(String(args[0]))?.signature
        this.current.sourceEncodedBytes += signature
          ? Buffer.from(signature, 'base64').byteLength
          : 0
      }
      return result
    })
    this.restores.push(
      instrumentPopulationWrappers(
        (target, property, intercept) => this.wrap(target, property, intercept),
        () => this.current,
        (value, name) => this.names.set(value, name)
      )
    )
    instrumentPopulationSql(
      (target, property, intercept) => this.wrap(target, property, intercept),
      () => this.current
    )
  }

  label(state: JournalReducerState): void {
    for (const [name, collection] of [
      ['items', state.items],
      ['submissions', state.submissions],
      ['aliases', state.aliases],
      ['cards', state.queue.cards],
      ['settlements', state.appliedSettlementIds]
    ] as const) {
      const source = populationSource(collection)
      this.names.set(collection, name)
      if (typeof source === 'object' && source !== null) {
        this.names.set(source, name)
      }
    }
  }

  private point(collection: PopulationCollection): void {
    const cost = this.current
    if (cost) {
      cost.points++
      const name = this.names.get(collection)
      if (name) {
        const entry = (cost.namespaces[name] ??= { points: 0, iterated: 0 })
        entry.points++
      }
    }
  }

  private iterated(collection: PopulationCollection): void {
    const cost = this.current
    if (cost) {
      cost.iteratorSteps++
      const name = this.names.get(collection)
      if (name === 'settlements') {
        cost.settlementIteratorSteps++
      }
      if (name) {
        const entry = (cost.namespaces[name] ??= { points: 0, iterated: 0 })
        entry.iterated++
      }
    }
  }

  private *iterate<T>(input: Iterable<T>, collection: PopulationCollection): IterableIterator<T> {
    for (const value of input) {
      this.iterated(collection)
      yield value
    }
  }

  private *construct<T>(input: Iterable<T>): IterableIterator<T> {
    for (const value of input) {
      if (this.current) {
        this.current.constructorInputs++
        const name = this.names.get(input)
        if (name === 'settlements') {
          this.current.settlementConstructorInputs++
        } else if (
          name &&
          /^(items|submissions|aliases|cards|workEntries|rest:|groupMembers|treeNodes)/.test(name)
        ) {
          this.current.populationCopiedInputs++
        }
      }
      yield value
    }
  }

  async measure<T>(run: () => T | Promise<T>): Promise<{ value: T; cost: PopulationCost }> {
    if (this.current) {
      throw new Error('overlapping population measurement')
    }
    const cost = emptyPopulationCost()
    this.current = cost
    try {
      return { value: await run(), cost }
    } finally {
      this.current = undefined
    }
  }

  close(): void {
    const restores = this.restores.splice(0).toReversed()
    this.restores.push(...restores)
    for (const restore of this.restores) {
      restore()
    }
    vi.unstubAllGlobals()
  }
}
