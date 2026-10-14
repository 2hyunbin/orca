import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginManifestV2Schema } from '../dist/runtime.mjs'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const templates = new Set(['locale', 'syntax', 'viewer', 'environment'])

export async function createPluginTemplate(type, destination, options) {
  if (!templates.has(type)) {
    throw new Error('Template type must be locale, syntax, viewer or environment')
  }
  if (!options.publisher || !options.id) {
    throw new Error('init requires --publisher and --id')
  }
  const output = resolve(destination)
  await mkdir(output)
  try {
    const template = resolve(packageRoot, 'templates', type)
    for (const entry of await readdir(template)) {
      if (entry === 'node_modules') {
        continue
      }
      await cp(resolve(template, entry), resolve(output, entry), {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: (path) => !relative(template, path).split(sep).includes('node_modules')
      })
    }
    const manifestPath = resolve(output, 'orca-plugin.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.publisher = options.publisher
    manifest.id = options.id
    pluginManifestV2Schema.parse(manifest)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await writeFile(resolve(output, '.gitignore'), 'node_modules/\n')
    await writeFile(resolve(output, '.gitattributes'), '* -text\n')
    const tooling = resolve(output, '.orca-tooling')
    await mkdir(tooling)
    for (const entry of [
      'src',
      'dist',
      'templates',
      'schemas',
      'package.json',
      'locale-kit.json',
      'LICENSE',
      'THIRD-PARTY-LICENSES.txt'
    ]) {
      await cp(resolve(packageRoot, entry), resolve(tooling, entry), {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: (path) => !relative(packageRoot, path).split(sep).includes('node_modules')
      })
    }
    return {
      template: type,
      id: `${options.publisher}.${options.id}`,
      output,
      validate: 'node .orca-tooling/src/cli.mjs validate .',
      note: 'Vendored validation is pinned to this toolkit snapshot. Review tooling refreshes in a separate contribution.'
    }
  } catch (error) {
    await rm(output, { recursive: true, force: true })
    throw error
  }
}
