import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { build } from 'vite'
import { electronViteConfig } from '../../electron.vite.config'

it('keeps shared main code working after a CLI build replaces its public entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-main-entry-facade-'))
  try {
    await writeFile(join(root, 'package.json'), '{"type":"commonjs"}')
    await writeFile(join(root, 'tracker.ts'), 'export const createTracker = () => ({ count: 0 })')
    await writeFile(
      join(root, 'controls.ts'),
      'import { createTracker } from "./tracker"; export const getStatus = () => createTracker().count'
    )
    await writeFile(
      join(root, 'main.ts'),
      'import { getStatus } from "./controls"; import { createTracker } from "./tracker"; export const state = { status: getStatus(), tracker: createTracker() }'
    )
    const options = electronViteConfig.main?.build?.rollupOptions
    await build({
      configFile: false,
      root,
      logLevel: 'silent',
      build: {
        ssr: true,
        minify: electronViteConfig.main?.build?.minify,
        rolldownOptions: {
          ...options,
          plugins: [],
          input: { index: join(root, 'main.ts'), controls: join(root, 'controls.ts') }
        }
      }
    })
    // tsc emits public names only, replacing the bundler's entry at this same path.
    await writeFile(join(root, 'dist', 'controls.js'), 'exports.getStatus = () => 0')
    const require = createRequire(import.meta.url)
    expect(require(join(root, 'dist', 'index.js')).state).toEqual({
      status: 0,
      tracker: { count: 0 }
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
