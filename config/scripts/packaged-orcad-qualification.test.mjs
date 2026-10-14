import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { writeOrcadTemplateTestFixture } from './orcad-template-test-fixture.mjs'
import { ORCAD_TEMPLATE_MANIFEST_FILENAME } from '../../src/shared/orcad-artifacts.ts'

const require = createRequire(import.meta.url)
const release = require('../electron-builder.config.cjs')
const qualification = require('../electron-builder-pr-linux.config.cjs')
const { Arch } = require('electron-builder')
const { finalizePackagedOrcadTemplate } = require('./packaged-orcad-template.cjs')
const roots = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('selects a marked, nonpublishing Linux target through the existing packaging hook', async () => {
  const finish = vi.spyOn(release, 'afterPack').mockResolvedValue(undefined)
  const context = {
    electronPlatformName: 'linux',
    arch: Arch.x64,
    packager: { info: { options: { publish: 'never' } } }
  }
  await qualification.afterPack(context)
  expect(finish).toHaveBeenCalledWith(context, { templateTargets: ['linux-x64-glibc'] })
  expect(qualification.publish).toBeNull()
  expect(qualification.extraMetadata.orcaQualificationBuild).toBe(true)
  expect(release.extraMetadata?.orcaQualificationBuild).toBeUndefined()
})

it.each([
  { electronPlatformName: 'darwin', arch: Arch.x64, publish: 'never' },
  { electronPlatformName: 'linux', arch: Arch.arm64, publish: 'never' },
  { electronPlatformName: 'linux', arch: Arch.x64, publish: 'always' },
  { electronPlatformName: 'linux', arch: Arch.x64, publish: undefined }
])('refuses an unintended qualification package: %j', async ({ publish, ...target }) => {
  const finish = vi.spyOn(release, 'afterPack').mockResolvedValue(undefined)
  await expect(
    qualification.afterPack({
      ...target,
      packager: { info: { options: { publish } } }
    })
  ).rejects.toThrow('requires Linux x64 and --publish never')
  expect(finish).not.toHaveBeenCalled()
})

it('verifies every retained byte for qualification while release still requires all targets', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const resources = await mkdtemp(join(tmpdir(), 'orca-qualification-template-'))
  roots.push(resources)
  const template = await writeOrcadTemplateTestFixture(resources)
  const manifestPath = join(template, ORCAD_TEMPLATE_MANIFEST_FILENAME)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const target of Object.keys(manifest.targets)) {
    if (target !== 'linux-x64-glibc') {
      delete manifest.targets[target]
      await rm(join(template, 'targets', target), { recursive: true, force: true })
    }
  }
  await writeFile(manifestPath, JSON.stringify(manifest))
  const options = { platform: 'linux', env: { ORCA_REQUIRE_ORCAD_TEMPLATE: '1' } }
  await expect(finalizePackagedOrcadTemplate(resources, options)).rejects.toThrow(
    'inventory mismatch'
  )
  await expect(
    finalizePackagedOrcadTemplate(resources, {
      ...options,
      targets: ['linux-x64-glibc']
    })
  ).resolves.toBeUndefined()
  const binary = Object.keys(manifest.targets['linux-x64-glibc'].files)[0]
  await writeFile(join(template, 'targets', 'linux-x64-glibc', binary), 'changed')
  await expect(
    finalizePackagedOrcadTemplate(resources, {
      ...options,
      targets: ['linux-x64-glibc']
    })
  ).rejects.toThrow()
})
