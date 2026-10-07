import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { parse } from 'acorn'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const source = readFileSync(
  process.env.ORCA_LIST_SOURCE_PATH ??
    join(dirname(require.resolve('@legendapp/list/react-native')), 'react-native.js'),
  'utf8'
)
const parsed = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })

it.each(['react-native.js', 'react-native.mjs', 'react-native.web.js', 'react-native.web.mjs'])(
  'parses the complete pinned %s entry',
  (entry) => {
    const bundle = readFileSync(
      join(dirname(require.resolve('@legendapp/list/react-native')), entry),
      'utf8'
    )
    expect(() => parse(bundle, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()
  }
)

function functionSource(name: string): string {
  const declaration = parsed.body.find(
    (node) => node.type === 'FunctionDeclaration' && node.id?.name === name
  )
  if (!declaration) {
    throw new Error(`Missing pinned list function: ${name}`)
  }
  return source.slice(declaration.start, declaration.end)
}

// Execute the shipped owner functions. Geometry is supplied here; UIKit is not simulated.
function initialFollow(): boolean | { animated: boolean } {
  return { animated: false }
}
function maintainedEnd() {
  const frames = new Map<number, () => void>()
  let frameId = 0
  const scrollToEnd = vi.fn()
  const context = {
    requestAnimationFrame: (callback: () => void) => {
      frames.set(++frameId, callback)
      return frameId
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: () => 1,
    clearTimeout: vi.fn(),
    peek$: () => true,
    getContentSize: () => 1500,
    isHorizontalRTL: () => false
  }
  const ScheduledWork = runInNewContext(
    source.slice(
      source.indexOf('var ScheduledWork = class'),
      source.indexOf('// src/core/ScrollAdjustHandler.ts')
    ) + '\nScheduledWork',
    context
  )
  const state = {
    didContainersLayout: true,
    scrollLength: 500,
    scroll: 1000,
    props: { maintainScrollAtEnd: initialFollow() },
    refScroller: { current: { scrollToEnd } },
    scheduledWork: new ScheduledWork()
  }
  state.props.maintainScrollAtEnd = { animated: false }
  const call = runInNewContext(
    functionSource('doMaintainScrollAtEnd') + '\ndoMaintainScrollAtEnd',
    context
  )
  return {
    state,
    frames,
    scrollToEnd,
    call: () => call({ state }),
    flush: () => {
      const pending = [...frames.entries()]
      for (const [id, callback] of pending) {
        frames.delete(id)
        callback()
      }
    }
  }
}

describe('pinned measured-list placement scheduling', () => {
  it('revokes a queued passive write before the first user offset arrives', () => {
    const list = maintainedEnd()
    list.call()
    list.state.props.maintainScrollAtEnd = false
    list.flush()
    expect(list.scrollToEnd).not.toHaveBeenCalled()
  })
  it('disposes a queued passive write with the transcript owner', () => {
    const list = maintainedEnd()
    list.call()
    list.state.scheduledWork.dispose()
    list.flush()
    expect(list.scrollToEnd).not.toHaveBeenCalled()
  })
  it('maintains current end once for a measured change', () => {
    const list = maintainedEnd()
    list.call()
    list.call()
    list.flush()
    expect(list.scrollToEnd).toHaveBeenCalledTimes(1)
    expect(list.scrollToEnd).toHaveBeenCalledWith({ animated: false })
  })
})

function anchorTrace(
  oldKeys: string[],
  oldPositions: number[],
  visible: string[],
  nextKeys = oldKeys,
  scroll = 650
) {
  const adjust = vi.fn()
  const state = {
    idsInView: visible,
    positions: oldPositions,
    indexByKey: new Map(oldKeys.map((id, index) => [id, index])),
    idCache: oldKeys,
    previousData: oldKeys,
    didContainersLayout: true,
    scroll,
    scrollLength: 400,
    props: {
      data: nextKeys,
      keyExtractor: (key: string) => key,
      maintainVisibleContentPosition: { data: true, size: true }
    }
  }
  const context = {
    Platform: { OS: 'ios' },
    IsNewArchitecture: true,
    MVCP_POSITION_EPSILON: 0.5,
    resolveAnchorLock: () => undefined,
    getContentSize: () => 3000,
    updateAnchorLock: vi.fn(),
    shouldQueueNativeMVCPAdjust: () => false,
    requestAdjust: (_ctx: unknown, delta: number) => adjust(delta),
    peek$: () => false,
    getId: (_state: unknown, index: number) => oldKeys[index]
  }
  const prepare = runInNewContext(functionSource('prepareMVCP') + '\nprepareMVCP', context)
  const ctx = { state }
  const apply = prepare(ctx, true)
  return { state, adjust, apply, prepare: () => prepare(ctx, false) }
}

describe('pinned measured-list entry and pixel restoration', () => {
  it('preserves a surviving entry through prepend plus simultaneous tail growth', () => {
    const list = anchorTrace(
      ['old', 'read', 'tail'],
      [0, 600, 1400],
      ['read'],
      ['page', 'old', 'read', 'tail', 'new']
    )
    list.state.indexByKey.clear()
    for (const [index, id] of ['page', 'old', 'read', 'tail', 'new'].entries()) {
      list.state.indexByKey.set(id, index)
    }
    list.state.positions.splice(0, list.state.positions.length, 0, 300, 900, 1700, 2300)
    list.apply()
    expect(list.adjust).toHaveBeenCalledWith(300)
  })
  it('returns to the nearest survivor when a removed tall entry has no matching pixel', () => {
    const list = anchorTrace(
      ['before', 'removed', 'after', 'tail'],
      [0, 600, 2200, 2300],
      ['removed'],
      ['page', 'before', 'after', 'tail'],
      1850
    )
    list.state.indexByKey.clear()
    for (const [index, id] of ['page', 'before', 'after', 'tail'].entries()) {
      list.state.indexByKey.set(id, index)
    }
    list.state.positions.splice(0, list.state.positions.length, 0, 300, 900, 1000)
    list.apply()
    expect(list.adjust).toHaveBeenCalledWith(-950)
  })
  it('uses the nearest surviving loaded neighbor when the sole visible key is removed', () => {
    const list = anchorTrace(
      ['before', 'removed', 'after'],
      [0, 600, 1400],
      ['removed'],
      ['page', 'before', 'after']
    )
    list.state.indexByKey.delete('removed')
    list.state.indexByKey.set('page', 0)
    list.state.indexByKey.set('before', 1)
    list.state.indexByKey.set('after', 2)
    list.state.positions.splice(0, list.state.positions.length, 0, 300, 900)
    list.apply()
    expect(list.adjust).toHaveBeenCalledWith(250)
  })
})

it('remeasured items above a detached entry preserve its within-entry pixel displacement', () => {
  const list = anchorTrace(['above', 'read', 'tail'], [0, 600, 1400], ['read'])
  const apply = list.prepare()
  list.state.positions.splice(0, 3, 0, 800, 1600)
  apply()
  expect(list.adjust).toHaveBeenCalledWith(200)
})

function bootstrap() {
  const dispatch = vi.fn()
  const queue = vi.fn()
  const state = {
    initialScroll: { index: 2, viewPosition: 1 },
    startBuffered: 1,
    endBuffered: 2,
    bootstrap: { scroll: 1100, seedContentOffset: 0, passCount: 0, mountFrameCount: 0 },
    props: { data: ['a', 'b', 'c'], keyExtractor: (key: string) => key },
    positions: [0, 600, 900],
    sizes: new Map([
      ['a', 600],
      ['b', 300],
      ['c', 700]
    ]),
    sizesKnown: new Map<string, number>(),
    indexByKey: new Map([
      ['a', 0],
      ['b', 1],
      ['c', 2]
    ]),
    idCache: ['a', 'b', 'c'],
    containerItemKeys: new Map([
      ['b', 1],
      ['c', 2]
    ]),
    scrollLength: 500
  }
  const context = {
    Platform: { OS: 'ios' },
    DEFAULT_BOOTSTRAP_REVEAL_EPSILON: 1,
    getBootstrapInitialScrollSession: () => state.bootstrap,
    isOffsetInitialScrollSession: () => false,
    abortBootstrapRevealIfNeeded: () => false,
    getItemSize: (_ctx: unknown, key: string) => state.sizes.get(key),
    getStartOffsetAdjustment: () => 0,
    getContentInsetEnd: () => 0,
    peek$: () => 0,
    getContentSize: () => 1600,
    queueBootstrapInitialScrollReevaluation: queue,
    clearBootstrapInitialScrollSession: vi.fn(),
    dispatchInitialScroll: dispatch,
    getObservedBootstrapInitialScrollOffset: () => 0
  }
  const program = [
    'getId',
    'calculateOffsetForIndex',
    'calculateOffsetWithOffsetPosition',
    'clampScrollOffset',
    'resolveInitialScrollOffset',
    'checkAllSizesKnown',
    'getBootstrapRevealVisibleIndices',
    'doVisibleIndicesMatch',
    'evaluateBootstrapInitialScroll'
  ]
    .map(functionSource)
    .join('\n')
  const evaluate = runInNewContext(program + '\nevaluateBootstrapInitialScroll', context)
  return { state, dispatch, evaluate: () => evaluate({ state, scrollAxisGap: 0 }) }
}

it('initial end waits for measured mounted/visible entries and a stable reveal set', () => {
  const list = bootstrap()
  list.evaluate()
  expect(list.dispatch).not.toHaveBeenCalled()
  list.state.sizesKnown.set('b', 300)
  list.evaluate()
  expect(list.dispatch).not.toHaveBeenCalled()
  list.state.sizesKnown.set('c', 700)
  list.evaluate()
  expect(list.dispatch).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ resolvedOffset: 1100 })
  )
})

it('initial bootstrap has finite convergence bounds rather than an app-level end chase', () => {
  const abort = runInNewContext(
    functionSource('shouldAbortBootstrapReveal') + '\nshouldAbortBootstrapReveal',
    {
      DEFAULT_BOOTSTRAP_REVEAL_MAX_FRAMES: 8,
      DEFAULT_BOOTSTRAP_REVEAL_MAX_PASSES: 24
    }
  )
  expect(abort({ mountFrameCount: 7, passCount: 23 })).toBe(false)
  expect(abort({ mountFrameCount: 8, passCount: 1 })).toBe(true)
  expect(abort({ mountFrameCount: 1, passCount: 24 })).toBe(true)
})

it('independent user acquisition cancels passive frames and unfinished placement in the list owner', () => {
  const list = maintainedEnd()
  list.call()
  const supersede = vi.fn()
  const cancel = vi.fn()
  const acquire = runInNewContext(functionSource('acquireUserScroll') + '\nacquireUserScroll', {
    supersedeInitialScroll: supersede,
    cancelImperativeScroll: cancel
  })
  acquire({ state: list.state })
  list.flush()
  expect(list.scrollToEnd).not.toHaveBeenCalled()
  expect(supersede).toHaveBeenCalledOnce()
  expect(cancel).toHaveBeenCalledWith(list.state)
})
