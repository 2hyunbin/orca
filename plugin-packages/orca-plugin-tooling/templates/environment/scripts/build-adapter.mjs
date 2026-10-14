import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const root = dirname(import.meta.dirname)
const vendored = resolve(root, '.orca-tooling/dist/runtime.mjs')
const runtime = existsSync(vendored)
  ? vendored
  : resolve(import.meta.dirname, '../../../dist/runtime.mjs')
await build({
  absWorkingDir: root,
  entryPoints: ['src/entry.mjs'],
  outfile: 'dist/provider.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  minify: true,
  legalComments: 'inline',
  plugins: [
    {
      name: 'orca-protocol-snapshot',
      setup(builder) {
        builder.onResolve({ filter: /\.orca-tooling\/dist\/runtime\.mjs$/ }, () => ({
          path: runtime
        }))
      }
    }
  ]
})
