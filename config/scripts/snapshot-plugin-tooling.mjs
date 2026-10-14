import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'

const root = resolve(import.meta.dirname, '../..')
const target = resolve(root, 'plugin-packages/orca-plugin-tooling')
const check = process.argv.includes('--check')
if (process.argv.slice(2).some((argument) => argument !== '--check')) {
  throw new Error('Only --check is supported')
}
const requireTooling = createRequire(resolve(target, 'package.json'))
const { build } = requireTooling('esbuild')
async function output(path, value) {
  const destination = resolve(target, path)
  if (check) {
    const existing = await readFile(destination)
    if (!existing.equals(Buffer.from(value))) {
      throw new Error(`Plugin tooling snapshot drift: ${path}`)
    }
  } else {
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, value)
  }
}
const built = await build({
  entryPoints: [resolve(root, 'config/scripts/plugin-tooling-runtime.ts')],
  outfile: resolve(target, 'dist/runtime.mjs'),
  bundle: true,
  write: false,
  alias: { zod: requireTooling.resolve('zod') },
  minify: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'eof',
  banner: { js: '// Generated from Orca runtime validators by snapshot-plugin-tooling.mjs.' }
})
await output('dist/runtime.mjs', built.outputFiles[0].contents)
const runtime = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`
)
const english = JSON.parse(
  await readFile(resolve(root, 'src/renderer/src/i18n/locales/en.json'), 'utf8')
)
await output(
  'locale-kit.json',
  `${JSON.stringify(runtime.createPluginLocaleKit(english), null, 2)}\n`
)
for (const [name, schema] of Object.entries({
  'manifest-v2': runtime.pluginManifestV2Schema,
  'locale-envelope': runtime.pluginLocaleEnvelopeSchema,
  'catalog-v2': runtime.pluginCatalogSchema,
  'language-configuration': runtime.pluginLanguageConfigurationSchema,
  'environment-recipe': runtime.pluginEnvironmentRecipeSchema
})) {
  const json = runtime.z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })
  json.$comment =
    'Generated from Orca runtime schemas. Cross-field, path, identity, source freshness and byte limits require orca-plugin validate; JSON Schema alone is not an approval boundary.'
  await output(`schemas/${name}.schema.json`, `${JSON.stringify(json, null, 2)}\n`)
}
console.log(
  `Plugin runtime snapshot, five schemas and English translation kit ${check ? 'verified' : 'generated'}.`
)
