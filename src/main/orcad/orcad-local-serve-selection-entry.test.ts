import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const hooks = vi.hoisted(() => ({
  select: vi.fn(),
  prune: vi.fn(async () => []),
  register: vi.fn(async () => undefined)
}))
vi.mock('./orcad-local-serve-selection', () => ({ selectServeRuntime: hooks.select }))
vi.mock('./orcad-artifact-cache-retention', () => ({ pruneDesktopOrcadArtifactCache: hooks.prune }))
vi.mock('../node-runtime/appimage-bundled-node-runtime', () => ({
  findAppImageNodeRuntime: () => null
}))
vi.mock('../cli/serve-cli-registration', () => ({ registerCliForServe: hooks.register }))

const originalArgv = process.argv
const originalResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
afterEach(() => {
  process.argv = originalArgv
  if (originalResources) {
    Object.defineProperty(process, 'resourcesPath', originalResources)
  } else {
    Reflect.deleteProperty(process, 'resourcesPath')
  }
  vi.restoreAllMocks()
})

it.each([
  ['app.asar', 'orcad'],
  ['app.asar.unpacked', 'orcad'],
  ['development', 'orcad'],
  ['app.asar', 'electron']
])('registers only a packaged Node selection: %s / %s', async (layout, runtime) => {
  vi.resetModules()
  hooks.register.mockClear()
  hooks.select.mockResolvedValue(
    runtime === 'orcad'
      ? { kind: 'orcad', version: 'fixture', runtime: '/node', entry: '/entry' }
      : { kind: 'electron', reason: null }
  )
  const resourcesPath = join(process.cwd(), 'fixture-resources')
  const appRoot = join(resourcesPath, layout)
  const userDataPath = join(process.cwd(), 'fixture-profile')
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resourcesPath })
  process.argv = ['node', 'selector', '--app-root', appRoot, '--user-data', userDataPath]
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  await import('./orcad-local-serve-selection-entry')
  await vi.waitFor(() =>
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('ORCA_SERVE_RUNTIME '),
      expect.any(Function)
    )
  )
  if (layout === 'development' || runtime === 'electron') {
    expect(hooks.register).not.toHaveBeenCalled()
  } else {
    expect(hooks.register).toHaveBeenCalledWith(
      expect.objectContaining({
        isPackaged: true,
        resourcesPath,
        appPath: appRoot,
        userDataPath
      })
    )
  }
})
