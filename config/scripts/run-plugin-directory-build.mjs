import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const options = new Map()
const allowed = new Set(['--catalog', '--source-url', '--source-ref'])
const args = process.argv.slice(2)
for (let index = 0; index < args.length; index += 2) {
  const option = args[index]
  const value = args[index + 1]
  if (!allowed.has(option) || options.has(option) || !value || value.startsWith('--')) {
    throw new Error(
      'Usage: build:plugin-directory --catalog FILE --source-url GIT_URL --source-ref REF'
    )
  }
  options.set(option, value)
}
if (options.size !== allowed.size) {
  throw new Error('A catalog, catalog Git URL and explicit catalog ref are required')
}
process.env.ORCA_PLUGIN_DIRECTORY_CATALOG = resolve(options.get('--catalog'))
process.env.ORCA_PLUGIN_DIRECTORY_SOURCE_URL = options.get('--source-url')
process.env.ORCA_PLUGIN_DIRECTORY_SOURCE_REF = options.get('--source-ref')
await build({
  configFile: fileURLToPath(new URL('../../vite.plugin-directory.config.ts', import.meta.url))
})
