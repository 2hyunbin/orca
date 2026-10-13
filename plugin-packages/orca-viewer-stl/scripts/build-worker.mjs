import { build } from 'esbuild'
import { dirname } from 'node:path'

await build({
  absWorkingDir: dirname(import.meta.dirname),
  entryPoints: ['src/worker.ts'],
  outfile: 'dist/stl.worker.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'inline'
})
