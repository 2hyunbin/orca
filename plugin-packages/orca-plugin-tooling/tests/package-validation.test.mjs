import assert from 'node:assert/strict'
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createPluginLocaleKit } from '../dist/runtime.mjs'
import {
  inspectPackage,
  loadLocaleKit,
  validateLocaleKit,
  validatePackage
} from '../src/package-validation.mjs'
import { fixture, json } from './plugin-fixture.mjs'

test('all four templates validate; data packs stay inert and executable families need review', async (t) => {
  for (const type of ['locale', 'syntax', 'viewer', 'environment']) {
    const { repo } = await fixture(t, type)
    const result = await inspectPackage(repo)
    assert.equal(result.needsExecutableApproval, type === 'viewer' || type === 'environment')
    assert.match(result.contentHash, /^[a-f0-9]{64}$/)
    if (type === 'locale') {
      assert.equal(result.locales[0].current, 1)
    }
  }
})

test('data-to-code and unknown fields are rejected without executing an entry', async (t) => {
  const { repo, scratch } = await fixture(t)
  const path = join(repo, 'orca-plugin.json')
  const original = JSON.parse(await readFile(path, 'utf8'))
  const marker = join(scratch, 'executed')
  await writeFile(
    join(repo, 'worker.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`
  )
  for (const candidate of [
    { ...original, main: 'worker.js' },
    { ...original, scripts: { install: 'worker.js' } },
    { ...original, execution: 'sandboxed-ui', main: 'worker.js' }
  ]) {
    await json(path, candidate)
    await assert.rejects(validatePackage(repo))
  }
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
})

test('environment validation reads declared adapter bytes without executing them and refuses unsafe artifacts', async (t) => {
  const { repo, scratch } = await fixture(t, 'environment')
  const marker = join(scratch, 'executed')
  const entry = join(repo, 'dist/provider.mjs')
  await writeFile(
    entry,
    `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'bad')`
  )
  assert.equal((await validatePackage(repo)).manifest.execution, 'instructional')
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
  await writeFile(entry, Buffer.alloc(1024 * 1024 + 1, 97))
  await assert.rejects(validatePackage(repo), /limit|large|exceed/i)
  const path = join(repo, 'recipes/environments.json')
  const recipe = JSON.parse(await readFile(path, 'utf8'))
  recipe.commands.list.entry = '../outside.mjs'
  await json(path, recipe)
  await assert.rejects(validatePackage(repo))
})

test('author validation tolerates ignored dependency files; release inspection refuses symlinks', async (t) => {
  const { repo } = await fixture(t)
  await json(join(repo, 'node_modules/package.json'), {})
  assert.equal((await validatePackage(repo)).manifest.execution, 'data')
  if (process.platform === 'win32') {
    return
  }
  await symlink('language-configuration.json', join(repo, 'linked.json'))
  await assert.rejects(inspectPackage(repo), /symlink/)
})

test('grammar dependencies, missing artifacts and empty license fail', async (t) => {
  const { repo } = await fixture(t)
  const grammar = join(repo, 'syntaxes/example.tmLanguage.json')
  await json(grammar, { scopeName: 'source.example', patterns: [{ include: 'source.unknown' }] })
  await assert.rejects(validatePackage(repo), /include|scope/)
  await writeFile(grammar, '{')
  await assert.rejects(validatePackage(repo))
  const second = await fixture(t)
  await writeFile(join(second.repo, 'LICENSE'), '  ')
  await assert.rejects(validatePackage(second.repo), /LICENSE/)
})

test('locale current/stale/obsolete and placeholders follow the runtime kit', async (t) => {
  const { repo } = await fixture(t, 'locale')
  const kit = await loadLocaleKit()
  const path = join(repo, 'locales/pt-BR.json')
  const locale = JSON.parse(await readFile(path, 'utf8'))
  const sample = Object.keys(locale.entries)[0]
  locale.entries[sample].sourceHash = `sha256:${'a'.repeat(64)}`
  locale.entries['test.old-key'] = { sourceHash: `sha256:${'b'.repeat(64)}`, value: 'Old' }
  await json(path, locale)
  let result = await validatePackage(repo)
  assert.equal(result.locales[0].stale, 1)
  assert.equal(result.locales[0].obsolete, 1)
  const key = Object.keys(kit.entries).find((value) => kit.entries[value].value.includes('{{'))
  assert.ok(key)
  locale.entries[key] = { sourceHash: kit.entries[key].sourceHash, value: 'Tokens removed' }
  await json(path, locale)
  await assert.rejects(validatePackage(repo), /placeholders/)
  delete locale.entries[key]
  locale.entries['auto.components.settings.PluginConsentDialog.review'] = {
    sourceHash: `sha256:${'c'.repeat(64)}`,
    value: 'Trust me'
  }
  await json(path, locale)
  await assert.rejects(validatePackage(repo), /protected/)
})

test('translation kits reject forged hashes and export excludes security copy', () => {
  const kit = createPluginLocaleKit({
    sample: 'Hi {{name}}',
    auto: { components: { settings: { PluginConsentDialog: { review: 'Review' } } } }
  })
  assert.equal(Object.keys(kit.entries).length, 1)
  assert.deepEqual(validateLocaleKit(kit), kit)
  kit.entries.sample.value = 'Changed'
  assert.throws(() => validateLocaleKit(kit), /hashes/)
})

test('binary package icons are checked as contained files without UTF-8 decoding', async (t) => {
  const { repo } = await fixture(t)
  const path = join(repo, 'orca-plugin.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.icon = 'icon.png'
  await json(path, manifest)
  await writeFile(join(repo, 'icon.png'), Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10))
  assert.equal((await validatePackage(repo)).id, 'example.syntax-example')
  manifest.icon = 'absent.png'
  await json(path, manifest)
  await assert.rejects(validatePackage(repo), /ENOENT/)
})
