import { resolve } from 'node:path'
import { resolveConfig as resolveElectronConfig } from 'electron-vite'
import { resolveConfig } from 'vite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.stubEnv('ORCA_UNMINIFIED_MAIN', '')
  vi.stubEnv('NODE_ENV', process.env.NODE_ENV)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

async function resolveMainConfig(command: 'build' | 'serve', watch = false) {
  const resolved = await resolveElectronConfig(
    { logLevel: 'silent', ...(watch ? { build: { watch: {} } } : {}) },
    command,
    command === 'serve' ? 'development' : 'production'
  )
  if (!resolved.config?.main) {
    throw new Error('Electron Vite did not resolve the main-process configuration')
  }
  // Electron Vite runs main through Vite's build command even in development.
  return resolveConfig({ ...resolved.config.main, configFile: false }, 'build')
}

describe('Electron Vite development compilation', () => {
  it.each([false, true])('skips main minification in development (watch=%s)', async (watch) => {
    const resolved = await resolveMainConfig('serve', watch)

    expect(resolved.build.minify).toBe(false)
    expect(resolved.build.sourcemap).toBe('hidden')
    expect(resolved.build.reportCompressedSize).toBe(false)
    expect(Boolean(resolved.build.watch)).toBe(watch)
  })

  it('keeps production minification and crash source maps', async () => {
    const resolved = await resolveMainConfig('build')

    expect(resolved.build.minify).toBe('oxc')
    expect(resolved.build.sourcemap).toBe('hidden')
    expect(resolved.build.reportCompressedSize).toBe(false)
  })

  it('honors the unminified main diagnostic override in production', async () => {
    vi.stubEnv('ORCA_UNMINIFIED_MAIN', '1')

    const resolved = await resolveMainConfig('build')

    expect(resolved.build.minify).toBe(false)
    expect(resolved.build.sourcemap).toBe('hidden')
  })

  it('keeps renderer dependency caches in this worktree and skips gzip reporting', async () => {
    const { config } = await resolveElectronConfig({ logLevel: 'silent' }, 'serve')
    if (!config?.renderer) {
      throw new Error('Electron Vite did not resolve the renderer configuration')
    }

    const resolved = await resolveConfig({ ...config.renderer, configFile: false }, 'serve')

    expect(resolved.cacheDir).toBe(resolve('.cache/vite/renderer').replaceAll('\\', '/'))
    expect(resolved.build.reportCompressedSize).toBe(false)
  })

  it('gives the web client its own worktree cache and skips gzip reporting', async () => {
    const resolved = await resolveConfig(
      { configFile: resolve('vite.web.config.ts'), logLevel: 'silent' },
      'serve'
    )

    expect(resolved.cacheDir).toBe(resolve('.cache/vite/web').replaceAll('\\', '/'))
    expect(resolved.build.reportCompressedSize).toBe(false)
  })
})
