import { describe, expect, it } from 'vitest'

import {
  countProjectCatalogAccesses,
  isScannedFile,
  SELECTOR_FILES
} from './check-project-catalog-read-ratchet.mjs'

describe('countProjectCatalogAccesses', () => {
  it('counts direct reads of the catalog fields on store state', () => {
    const text = [
      'const repos = state.repos',
      'useAppStore((s) => s.projectGroups)',
      'const projects = get().projects',
      'const setups = useAppStore.getState().projectHostSetups',
      'const maybe = state?.repos ?? []'
    ].join('\n')
    expect(countProjectCatalogAccesses(text)).toBe(5)
  })

  it('counts catalog keys a store writer sets', () => {
    const text = ['set((s) => ({', '  repos: next,', '  projectGroups', '}))'].join('\n')
    expect(countProjectCatalogAccesses(text)).toBe(2)
  })

  it('ignores other receivers, the preload API, comments, strings and selector calls', () => {
    const text = [
      'await window.api.repos.list()',
      'const rows = args.repos',
      'const next = server.state.repos',
      '// state.repos used to be read here',
      "t('auto.store.slices.repos.1')",
      'const repos = selectRepos(state)',
      'const literal = { repos: [] }'
    ].join('\n')
    expect(countProjectCatalogAccesses(text)).toBe(0)
  })
})

describe('isScannedFile', () => {
  it('scans renderer sources but not tests or the selector module', () => {
    expect(isScannedFile('src/renderer/src/lib/foo.ts')).toBe(true)
    expect(isScannedFile('src/renderer/src/lib/foo.test.ts')).toBe(false)
    for (const file of SELECTOR_FILES.keys()) {
      expect(isScannedFile(file)).toBe(false)
    }
  })
})
