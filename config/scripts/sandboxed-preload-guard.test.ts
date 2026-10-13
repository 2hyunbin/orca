import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import { createSandboxedPreloadGuardPlugin } from '../build-plugins/sandboxed-preload-guard'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(viewerSource: string) {
  const root = await mkdtemp(join(tmpdir(), 'orca-preload-build-'))
  roots.push(root)
  await writeFile(join(root, 'viewer.ts'), viewerSource)
  await writeFile(join(root, 'feature.ts'), 'export const marker = Date.now()')
  await writeFile(join(root, 'host.ts'), 'import { marker } from "./feature"; console.log(marker)')
  return {
    configFile: false as const,
    logLevel: 'silent' as const,
    plugins: [createSandboxedPreloadGuardPlugin(['viewer'])],
    build: {
      write: false,
      minify: false as const,
      rollupOptions: {
        input: { viewer: join(root, 'viewer.ts'), host: join(root, 'host.ts') },
        external: ['electron', 'node:fs'],
        output: { format: 'cjs' as const }
      }
    }
  }
}

describe('standalone sandboxed preload bundles', () => {
  it('accepts the restricted Electron require in a real multi-entry build', async () => {
    const config = await fixture(
      'const { contextBridge } = require("electron"); contextBridge.exposeInMainWorld("narrow", Object.freeze({ ready: true }))'
    )
    await expect(build(config)).resolves.toBeDefined()
  })

  it('rejects shared chunks that Electron cannot require from a sandboxed preload', async () => {
    const config = await fixture(
      'import { marker } from "./feature"; const { contextBridge } = require("electron"); contextBridge.exposeInMainWorld("narrow", { marker })'
    )
    await expect(build(config)).rejects.toThrow('sandboxed_preload_dependency: viewer')
  })

  it('rejects an unsupported raw require rather than trusting untracked dependencies', async () => {
    const config = await fixture('const fs = require("node:fs"); console.log(fs)')
    await expect(build(config)).rejects.toThrow('sandboxed_preload_dependency: viewer: node:fs')
  })

  it('fails when an entry rename would silently remove preload protection', async () => {
    const config = await fixture('console.log("preload")')
    config.plugins = [createSandboxedPreloadGuardPlugin(['renamed-viewer'])]
    await expect(build(config)).rejects.toThrow('sandboxed_preload_missing: renamed-viewer')
  })
})
