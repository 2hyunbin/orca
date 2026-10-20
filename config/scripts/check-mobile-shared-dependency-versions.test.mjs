import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findSharedDependencyVersionProblems,
  main
} from './check-mobile-shared-dependency-versions.mjs'

const projectDir = path.resolve(import.meta.dirname, '../..')
const locked = (version) => ({ dependencies: { zod: { specifier: '~4.6.0', version } } })

describe('findSharedDependencyVersionProblems', () => {
  it('passes when both lockfiles resolve the same version', () => {
    expect(
      findSharedDependencyVersionProblems({
        rootImporter: locked('4.6.7'),
        mobileImporter: locked('4.6.7')
      })
    ).toEqual([])
  })

  it('reports two resolved versions', () => {
    expect(
      findSharedDependencyVersionProblems({
        rootImporter: locked('4.6.7'),
        mobileImporter: locked('4.6.5')
      })
    ).toEqual(['zod: the root locks 4.6.7, mobile locks 4.6.5'])
  })

  it('ignores peer suffixes and reads devDependencies', () => {
    expect(
      findSharedDependencyVersionProblems({
        rootImporter: { devDependencies: { zod: { version: '4.6.7(typescript@6.0.3)' } } },
        mobileImporter: locked('4.6.7')
      })
    ).toEqual([])
  })

  it('reports a side that stopped declaring the dependency', () => {
    expect(
      findSharedDependencyVersionProblems({ rootImporter: locked('4.6.7'), mobileImporter: {} })
    ).toEqual(['zod is not a direct dependency of mobile'])
  })
})

describe('committed lockfiles', () => {
  it('pass the repository check', () => {
    expect(main(projectDir)).toBe(0)
  })
})
