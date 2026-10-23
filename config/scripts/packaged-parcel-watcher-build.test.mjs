import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { finalizePackagedParcelWatcherBuild } = require('../packaged-parcel-watcher-build.cjs')

const roots = []

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop(), { recursive: true, force: true })
  }
})

function makeResources({ addon = true } = {}) {
  const resourcesDir = mkdtempSync(path.join(tmpdir(), 'orca-packaged-watcher-'))
  roots.push(resourcesDir)
  const buildDir = path.join(resourcesDir, 'node_modules', '@parcel', 'watcher', 'build')
  mkdirSync(path.join(buildDir, 'Release', 'obj.target'), { recursive: true })
  writeFileSync(path.join(buildDir, 'Makefile'), '')
  writeFileSync(path.join(buildDir, 'Release', '.deps'), '')
  if (addon) {
    writeFileSync(path.join(buildDir, 'Release', 'watcher.node'), 'addon')
  }
  return { resourcesDir, buildDir }
}

describe('finalizePackagedParcelWatcherBuild', () => {
  it('keeps only the verified addon in a macOS slice', () => {
    const { resourcesDir, buildDir } = makeResources()
    const verified = []
    finalizePackagedParcelWatcherBuild(resourcesDir, 'darwin', 'x64', (binary, arch) => {
      verified.push([path.relative(buildDir, binary), arch])
      return null
    })
    expect(verified).toEqual([[path.join('Release', 'watcher.node'), 'x64']])
    expect(readdirSync(buildDir)).toEqual(['Release'])
    expect(readdirSync(path.join(buildDir, 'Release'))).toEqual(['watcher.node'])
  })

  it('fails a macOS slice that would fall back to the upstream prebuild', () => {
    const { resourcesDir } = makeResources({ addon: false })
    expect(() =>
      finalizePackagedParcelWatcherBuild(resourcesDir, 'darwin', 'arm64', () => null)
    ).toThrow(/no patched @parcel\/watcher build/)
  })

  it('fails a macOS slice whose addon is for another arch', () => {
    const { resourcesDir } = makeResources()
    expect(() =>
      finalizePackagedParcelWatcherBuild(resourcesDir, 'darwin', 'arm64', () => 'no arm64 slice')
    ).toThrow('Packaging darwin/arm64: no arm64 slice')
  })

  it('drops any build dir elsewhere, where the prebuild is what loads', () => {
    const { resourcesDir, buildDir } = makeResources()
    finalizePackagedParcelWatcherBuild(
      resourcesDir,
      'linux',
      'x64',
      () => 'not consulted off macOS'
    )
    expect(existsSync(buildDir)).toBe(false)
  })

  it('ignores a resources tree without the watcher', () => {
    const resourcesDir = mkdtempSync(path.join(tmpdir(), 'orca-packaged-watcher-none-'))
    roots.push(resourcesDir)
    expect(() => finalizePackagedParcelWatcherBuild(resourcesDir, 'darwin', 'arm64')).not.toThrow()
  })
})
