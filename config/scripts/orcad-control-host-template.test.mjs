import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import {
  orcadTemplateCommonFilenames,
  ORCAD_TEMPLATE_MANIFEST_FILENAME
} from '../../src/shared/orcad-artifacts.ts'
import { writeOrcadTemplateTestFixture } from './orcad-template-test-fixture.mjs'
import {
  stageControlHostTemplate,
  verifyControlHostTemplate
} from './orcad-control-host-template.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-control-template-'))
  roots.push(root)
  const template = await writeOrcadTemplateTestFixture(join(root, 'source'))
  const server = join(root, 'server')
  for (const filename of orcadTemplateCommonFilenames()) {
    mkdirSync(dirname(join(server, filename)), { recursive: true })
    copyFileSync(join(template, filename), join(server, filename))
  }
  return { root, template, server }
}
it('packages the verified matrix without undeclared or recursively nested resources', async () => {
  const { template, server } = await fixture()
  writeFileSync(join(template, 'undeclared-entry.js'), 'unchecked')
  const published = stageControlHostTemplate(server, template)
  expect(existsSync(join(published, ORCAD_TEMPLATE_MANIFEST_FILENAME))).toBe(true)
  expect(existsSync(join(published, 'undeclared-entry.js'))).toBe(false)
  expect(readdirSync(join(server, 'resources'))).toEqual(['orcad-template'])
  verifyControlHostTemplate(join(server, 'sibling'), template)
})
it('refuses a template from a different server build without publishing resources', async () => {
  const { template, server } = await fixture()
  writeFileSync(join(server, 'orcad-server.js'), 'different build')
  expect(() => stageControlHostTemplate(server, template)).toThrow('different server bytes')
  expect(existsSync(join(server, 'resources'))).toBe(false)
})
it('refuses corrupted target bytes before publication', async () => {
  const { template, server } = await fixture()
  writeFileSync(join(template, 'targets/darwin-arm64/.runtime-node'), 'corrupt')
  expect(() => stageControlHostTemplate(server, template)).toThrow('checksum mismatch')
  expect(existsSync(join(server, 'resources'))).toBe(false)
})
it('requires all targets by default and allows an explicitly narrowed CI matrix', async () => {
  const { template, server } = await fixture()
  const path = join(template, ORCAD_TEMPLATE_MANIFEST_FILENAME)
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  for (const target of Object.keys(manifest.targets)) {
    if (target === 'linux-x64-glibc') {
      continue
    }
    delete manifest.targets[target]
    rmSync(join(template, 'targets', target), { recursive: true })
  }
  writeFileSync(path, JSON.stringify(manifest))
  expect(() => stageControlHostTemplate(server, template)).toThrow(
    'target manifest inventory mismatch'
  )
  expect(stageControlHostTemplate(server, template, ['linux-x64-glibc'])).toBe(
    join(server, 'resources/orcad-template')
  )
})
it('refuses overlap before a package rebuild can erase its template', async () => {
  const { template, server } = await fixture()
  expect(() => verifyControlHostTemplate(dirname(template), template)).toThrow(
    'outside the server package'
  )
  expect(() => verifyControlHostTemplate(join(template, 'server'), template)).toThrow(
    'outside the server package'
  )
  expect(() => verifyControlHostTemplate(server, join(template, 'other-name'))).toThrow(
    'must be named'
  )
})
it('preserves an existing deployment matrix if a second publication is attempted', async () => {
  const { template, server } = await fixture()
  const published = stageControlHostTemplate(server, template)
  const before = readFileSync(join(published, ORCAD_TEMPLATE_MANIFEST_FILENAME))
  expect(() => stageControlHostTemplate(server, template)).toThrow('already contains')
  expect(readFileSync(join(published, ORCAD_TEMPLATE_MANIFEST_FILENAME))).toEqual(before)
  expect(readdirSync(join(server, 'resources'))).toEqual(['orcad-template'])
})

it('refuses symlinked overlap before rebuilding an output beneath the source', async () => {
  const { root, template } = await fixture()
  const alias = join(root, 'source-alias')
  symlinkSync(dirname(template), alias, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => verifyControlHostTemplate(alias, template)).toThrow('outside the server package')
})
