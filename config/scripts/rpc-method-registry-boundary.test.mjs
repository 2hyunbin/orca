import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { expect, it, vi } from 'vitest'

it('enumerates the real RPC surface with zero implementation module evaluations', async () => {
  const root = path.resolve(import.meta.dirname, '../..')
  const methods = path.join(root, 'src/main/runtime/rpc/methods')
  const source = readFileSync(path.join(methods, 'method-loaders.ts'), 'utf8')
  const implementations = new Set(
    [...source.matchAll(/import\('([^']+)'\)/g)].map(([, specifier]) =>
      path.resolve(methods, `${specifier}.ts`)
    )
  )
  expect(implementations.size).toBeGreaterThan(0)
  const result = await build({
    stdin: {
      contents: `import { ALL_RPC_METHODS } from './index';
        export const methods = ALL_RPC_METHODS.map(({ name, permission, params, stream }) =>
          ({ name, permission, params, stream }));`,
      resolveDir: methods,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    write: false,
    logLevel: 'silent',
    define: { ORCA_LAYOUT_OWNER: '"main"', ORCA_SIDEBAR_INPUTS: '"main"' },
    plugins: [
      {
        name: 'observe-implementation-evaluation',
        setup(builder) {
          builder.onLoad({ filter: /\.ts$/ }, ({ path: file }) => {
            if (!implementations.has(file)) {
              return undefined
            }
            return {
              contents: `recordImplementationLoad(${JSON.stringify(file)});\n${readFileSync(file, 'utf8')}`,
              loader: 'ts'
            }
          })
        }
      }
    ]
  })
  const recordImplementationLoad = vi.fn()
  const module = { exports: {} }
  runInNewContext(result.outputFiles[0].text, {
    module,
    require: createRequire(path.join(methods, 'index.ts')),
    process,
    Buffer,
    TextDecoder,
    TextEncoder,
    URL,
    console,
    recordImplementationLoad
  })
  expect(module.exports.methods).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'aiVault.prepareSessionResume', permission: 'workspace' }),
      expect.objectContaining({ name: 'computer.click', permission: 'desktop-control' }),
      expect.objectContaining({ name: 'layout.apply', permission: 'workspace' }),
      expect.objectContaining({ name: 'sidebarInputs.read', permission: 'workspace' })
    ])
  )
  expect(recordImplementationLoad).not.toHaveBeenCalled()
})
