import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { runOxlintPluginOnSources } from './oxlint-plugin-test-runner.mjs'

const pluginPath = path.resolve('config/oxlint-plugins/app-store-performance.mjs')

function lintSources(sources) {
  return runOxlintPluginOnSources({
    pluginName: 'app-store-performance',
    pluginPath,
    sources,
    rules: {
      'app-store-performance/no-state-ignoring-selector': 'warn',
      'app-store-performance/no-tab-map-scan-in-selector': 'warn',
      'app-store-performance/require-selector': 'warn',
      'app-store-performance/no-identity-selector': 'warn',
      'app-store-performance/no-fresh-selector-result': 'warn',
      'app-store-performance/no-nested-fresh-under-shallow': 'warn'
    }
  })
}

const sources = {
  subscriptions: `
      import { useAppStore as useStore } from '@/store'
      const WholeStore = () => useStore()
      const Identity = () => useStore((state) => state)
      const Fresh = () => useStore((state) => ({ active: state.active }))
      const Conditional = () => useStore((state) => state.active ? state.items : [])
      const Nested = () => useStore((state) => {
        if (state.active) return state.items.filter(Boolean)
        return state.items
      })
    `,
  focusedSelectors: `
      import { useAppStore } from '@/store'
      import { useShallow as shallow } from 'zustand/react/shallow'
      const selectActive = (state) => state.active
      const Focused = () => useAppStore(selectActive)
      const Cached = () => useAppStore((state) => state.cachedProjection)
      const Shallow = () => useAppStore(shallow((state) => ({ active: state.active })))
    `,
  namedSelectors: `
      import { useAppStore } from '@/store'
      const EarlyFresh = () => useAppStore(selectFreshRows)
      const selectFreshRows = (state) => state.rows.filter(Boolean)
      const Stable = () => useAppStore(selectActiveId)
      const selectActiveId = (state) => state.activeId
    `,
  importedSelector: `
      import { useAppStore } from '@/store'
      import { selectRows } from './selectors'
      const Other = () => {
        const selectRows = (state) => state.rows.map((row) => row.id)
        return selectRows
      }
      const Imported = () => useAppStore(selectRows)
    `,
  siblingStores: `
      import { usePluginPanelsStore } from '@/store/plugin-panels'
      import { useSyncExternalStore } from 'react'
      const WholePanels = () => usePluginPanelsStore()
      const FreshPanels = () => usePluginPanelsStore((state) => ({ open: state.open }))
      const External = () => useSyncExternalStore(subscribe, () => ({ open: true }))
    `,
  nestedShallow: `
      import { useAppStore } from '@/store'
      import { useShallow } from 'zustand/react/shallow'
      const NestedObject = () => useAppStore(useShallow((state) => ({ ids: state.rows.map((row) => row.id) })))
      const NestedArray = () => useAppStore(useShallow((state) => [state.activeId, state.rows.filter(Boolean)]))
      const Flat = () => useAppStore(useShallow((state) => ({ activeId: state.activeId, rows: state.rows })))
    `,
  delegatingSelectors: `
      import { useAppStore } from '@/store'
      import { useShallow } from 'zustand/react/shallow'
      const buildRows = (state) => state.rows.map((row) => row.id)
      const Delegating = () => useAppStore((state) => buildRows(state))
      const NestedDelegating = () => useAppStore(useShallow((state) => ({ ids: buildRows(state) })))
    `,
  ignoringState: `
    import { useAppStore } from '@/store'
    import { useShallow } from 'zustand/react/shallow'
    const selectConstant = (state) => constant
    const Zero = () => useAppStore(() => readCurrent())
    const Unused = () => useAppStore(useShallow((state) => constant))
    const Named = () => useAppStore(selectConstant)
  `,
  scanningMaps: `
    import { useAppStore } from '@/store'
    const findChatTab = (state, sessionId, owner) => {
      const tabsByWorktree = state.unifiedTabsByWorktree
      for (const worktreeId in tabsByWorktree) {
        const tab = structuredChatTabBySessionId(tabsByWorktree, worktreeId, sessionId)
        if (tab && ownerForTab(state, tab) === owner) return tab
        const qualified = tab && tabsByWorktree[worktreeId]?.find(candidate => ownerForTab(state, candidate) === owner)
        if (qualified) return qualified
      }
      return undefined
    }
    const Sender = () => useAppStore(state => local && sessionId ? findChatTab(state, sessionId, owner) : undefined)
    const Direct = () => useAppStore(state => Object.values(state.tabsByWorktree))
    const Keys = () => useAppStore(state => Object.keys(state.worktreesByRepo).length)
    const Aliased = () => useAppStore(state => {
      const m = state.groupsByWorktree
      if (enabled) for (const key in m) inspect(key)
      return state.activeId
    })
  `,
  cachedMaps: `
    import { useAppStore } from '@/store'
    const cache = new WeakMap()
    const cached = state => {
      const map = state.unifiedTabsByWorktree
      const hit = cache.get(map)
      if (hit) return hit
      const value = Object.values(map)
      cache.set(map, value)
      return value
    }
    let previous, value
    const identityCached = state => {
      const { tabsByWorktree: tabs } = state
      if (previous !== state.tabsByWorktree) {
        value = Object.entries(tabs)
        previous = state.tabsByWorktree
      }
      return value
    }
    const Weak = () => useAppStore(state => cached(state))
    const Identity = () => useAppStore(state => identityCached(state))
    const Snapshot = () => useAppStore(({ active }) => active)
    const Callback = () => useAppStore(state => lookup(() => state.active))
    const External = () => useAppStore(state => importedIndex(state))
  `,
  cachedHelpers: `
      import { useAppStore } from '@/store'
      import { useShallow } from 'zustand/react/shallow'
      // The identity-caching shape: fresh only on a miss, cached otherwise.
      const selectCachedRows = (state) => cache.get(state.key) ?? state.rows.filter(Boolean)
      const Cached = () => useAppStore((state) => selectCachedRows(state))
      const CachedNested = () => useAppStore(useShallow((state) => ({ rows: selectCachedRows(state) })))
      // An unknown helper cannot be resolved, so it must not be guessed at.
      const External = () => useAppStore((state) => externalBuild(state))
    `,
  lexicalBindings: `
    import { useAppStore } from '@/store'
    const select = () => 42
    function lookup(s) { return Object.keys(s.tabsByWorktree).length }
    function View() {
      const select = s => s.activeId
      const lookup = s => s.activeId
      useAppStore(select)
      return useAppStore(s => lookup(s))
    }
    const Shadowed = () => useAppStore(s => fixedRows.some(s => s.enabled))
    const Captured = () => useAppStore(s => fixedRows.some(row => row.id === s.activeId))
  `,
  unrelatedCaches: `
    import { useAppStore } from '@/store'
    const cache = new WeakMap()
    const other = readOtherSnapshot()
    let previous
    const identity = s => {
      if (previous !== s.tabsByWorktree) {
        previous = s.tabsByWorktree
        inspect(Object.keys(s.tabsByWorktree))
      }
      return Object.keys(s.unifiedTabsByWorktree).length
    }
    const weak = s => {
      const hit = cache.get(other.tabsByWorktree)
      if (hit) return hit
      return Object.keys(s.tabsByWorktree).length
    }
    const Identity = () => useAppStore(identity)
    const Weak = () => useAppStore(weak)
  `,
  destructuredMaps: `
    import { useAppStore } from '@/store'
    const Parameter = () => useAppStore(({ tabsByWorktree }) => Object.keys(tabsByWorktree).length)
    const Local = () => useAppStore(s => {
      const { unifiedTabsByWorktree: tabs } = s
      return Object.keys(tabs).length
    })
  `
}

const diagnosticsBySource = new Map()
beforeAll(() => {
  const fixtures = Object.values(sources)
  lintSources(fixtures).forEach((diagnostics, index) => {
    diagnosticsBySource.set(fixtures[index], diagnostics)
  })
})

describe('app store performance Oxlint plugin', () => {
  it('reports whole-store and fresh-reference subscriptions', () => {
    const diagnostics = diagnosticsBySource.get(sources.subscriptions)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'app-store-performance(require-selector)',
      'app-store-performance(no-identity-selector)',
      'app-store-performance(no-fresh-selector-result)',
      'app-store-performance(no-fresh-selector-result)',
      'app-store-performance(no-fresh-selector-result)'
    ])
  })

  it('allows focused, cached, and useShallow selectors', () => {
    const diagnostics = diagnosticsBySource.get(sources.focusedSelectors)

    expect(diagnostics).toEqual([])
  })

  it('resolves selectors referenced by name, including ones hoisted below the call', () => {
    const diagnostics = diagnosticsBySource.get(sources.namedSelectors)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'app-store-performance(no-fresh-selector-result)'
    ])
  })

  it('does not let a component-local helper resolve a same-named imported selector', () => {
    const diagnostics = diagnosticsBySource.get(sources.importedSelector)

    expect(diagnostics).toEqual([])
  })

  it('covers sibling store hooks but not useSyncExternalStore', () => {
    const diagnostics = diagnosticsBySource.get(sources.siblingStores)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'app-store-performance(require-selector)',
      'app-store-performance(no-fresh-selector-result)'
    ])
  })

  it('reports fresh references nested inside a useShallow projection', () => {
    const diagnostics = diagnosticsBySource.get(sources.nestedShallow)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'app-store-performance(no-nested-fresh-under-shallow)',
      'app-store-performance(no-nested-fresh-under-shallow)'
    ])
  })

  it('follows a selector one hop into a module-scope helper', () => {
    const diagnostics = diagnosticsBySource.get(sources.delegatingSelectors)

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'app-store-performance(no-fresh-selector-result)',
      'app-store-performance(no-nested-fresh-under-shallow)'
    ])
  })

  it('does not flag a helper that returns a cached reference on some branch', () => {
    const diagnostics = diagnosticsBySource.get(sources.cachedHelpers)

    expect(diagnostics).toEqual([])
  })
})

describe('per-write selector work', () => {
  it('reports inline, shallow, and named state-ignoring selectors', () => {
    expect(diagnosticsBySource.get(sources.ignoringState).map(({ code }) => code)).toEqual([
      'app-store-performance(no-state-ignoring-selector)',
      'app-store-performance(no-state-ignoring-selector)',
      'app-store-performance(no-state-ignoring-selector)'
    ])
  })
  it('follows conditional sender helpers and local collection aliases', () => {
    expect(
      diagnosticsBySource
        .get(sources.scanningMaps)
        .filter(({ code }) => code === 'app-store-performance(no-tab-map-scan-in-selector)')
    ).toHaveLength(4)
  })
  it('allows same-file WeakMap and identity-guard caches', () => {
    expect(diagnosticsBySource.get(sources.cachedMaps)).toEqual([])
  })
  it('resolves lexical bindings and distinguishes shadowed callback parameters from captures', () => {
    const diagnostics = diagnosticsBySource.get(sources.lexicalBindings)
    expect(diagnostics.map(({ code }) => code)).toEqual([
      'app-store-performance(no-state-ignoring-selector)'
    ])
    expect(diagnostics[0].labels[0].span.offset).toBe(
      sources.lexicalBindings.indexOf('s => fixedRows.some(s => s.enabled)')
    )
  })
  it('does not exempt scans of a different map from a recognized cache', () => {
    expect(diagnosticsBySource.get(sources.unrelatedCaches).map(({ code }) => code)).toEqual([
      'app-store-performance(no-tab-map-scan-in-selector)',
      'app-store-performance(no-tab-map-scan-in-selector)'
    ])
  })
  it('recognizes listed maps destructured from parameters or local snapshots', () => {
    expect(diagnosticsBySource.get(sources.destructuredMaps).map(({ code }) => code)).toEqual([
      'app-store-performance(no-tab-map-scan-in-selector)',
      'app-store-performance(no-tab-map-scan-in-selector)'
    ])
  })
})
