import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { markdownParserAliases } from '../build-plugins/markdown-parser-exports'

const repoNodeModules = join(import.meta.dirname, '../../node_modules')

// Node's own lookup from the package's real location, without tripping over "exports" maps.
function isVisibleFrom(owner: string, dependency: string): boolean {
  const ownerDir = realpathSync(join(repoNodeModules, owner))
  const lookupDirs = createRequire(join(ownerDir, 'package.json')).resolve.paths(dependency) ?? []
  return lookupDirs.some((dir) => existsSync(join(dir, dependency, 'package.json')))
}

describe('undeclared dependency resolution', () => {
  // Why: the global virtual store links only declared deps; pnpm-workspace.yaml packageExtensions supply these.
  it.each([
    ['electron-vite', 'electron'],
    ['@testing-library/jest-dom', 'vitest'],
    ['@testing-library/jest-dom', '@types/aria-query'],
    ['lucide-react', '@types/react'],
    ['playwright-core', 'electron'],
    ['remark-parse', 'vfile'],
    ['mermaid', '@types/d3-selection']
  ])('%s sees %s from its own install location', (owner, dependency) => {
    expect(isVisibleFrom(owner, dependency)).toBe(true)
  })

  it('aliases the DOM-free decode-named-character-reference entry', () => {
    expect(markdownParserAliases['decode-named-character-reference']).toMatch(/[\\/]index\.js$/)
  })
})
