import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ORCAD_VERSION_FILENAME } from '../../shared/orcad-artifacts'
import { resolveOrcadBuildVersion } from './orcad-build-version'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'orca-build-version-'))
  directories.push(path)
  return path
}
it('reports the installed artifact marker even with a stale supervisor version', () => {
  const path = directory()
  writeFileSync(join(path, ORCAD_VERSION_FILENAME), '0.1.0+installed-hash\n')
  expect(resolveOrcadBuildVersion(path, { ORCA_VERSION: '0.1.0+stale-hash' })).toBe(
    '0.1.0+installed-hash'
  )
})
it('keeps the explicit version and source fallback for unpackaged entries', () => {
  const path = directory()
  expect(resolveOrcadBuildVersion(path, { ORCA_VERSION: '1.5.0-local' })).toBe('1.5.0-local')
  expect(resolveOrcadBuildVersion(path, {})).toBe('0.0.0-orcad')
})
it.each(['', 'garbage', '../foreign-slot', `1.0.0+${'a'.repeat(256)}`])(
  'refuses an invalid or oversized marker instead of masking it with an environment value',
  (value) => {
    const path = directory()
    writeFileSync(join(path, ORCAD_VERSION_FILENAME), value)
    expect(() => resolveOrcadBuildVersion(path, { ORCA_VERSION: '1.5.0' })).toThrow(
      'marker is invalid'
    )
  }
)
it('refuses an invalid unpackaged version', () => {
  expect(() => resolveOrcadBuildVersion(directory(), { ORCA_VERSION: 'invalid' })).toThrow(
    'build version is invalid'
  )
})
