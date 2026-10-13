import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const root = dirname(import.meta.dirname)
await mkdir(join(root, 'dist'), { recursive: true })
await build({
  absWorkingDir: root,
  entryPoints: ['src/worker.ts'],
  outfile: 'dist/xlsx.worker.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'inline',
  plugins: [
    {
      name: 'xml-parser-worker-build',
      setup(builder) {
        // SAXParser does not use its package's optional Node stream wrapper.
        builder.onResolve({ filter: /^stream$/ }, () => ({
          path: 'stream',
          namespace: 'worker-only'
        }))
        builder.onLoad({ filter: /^stream$/, namespace: 'worker-only' }, () => ({
          contents: 'export const Stream = undefined'
        }))
      }
    }
  ]
})
const licenses = await Promise.all([
  readFile(join(root, 'node_modules', 'fflate', 'LICENSE'), 'utf8'),
  readFile(join(root, 'node_modules', 'sax', 'LICENSE.md'), 'utf8')
])
await writeFile(
  join(root, 'THIRD-PARTY-LICENSES.txt'),
  `fflate 0.8.3\n${licenses[0]}\nsax 1.6.1\n${licenses[1]}`
)
