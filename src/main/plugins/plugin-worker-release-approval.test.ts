import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPluginExtensionRegistry } from '../../shared/plugins/plugin-extension-registry'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import { PluginContentVerifier } from './plugin-content-integrity'
import { discoverPluginConsent } from './plugin-discovery-consent'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginWorkerHandle } from './plugin-host-process'
import { PluginWorkerController } from './plugin-worker-controller'
import { buildPluginWorkerSpawnSpec, pluginWorkerSpawnSpecsEqual } from './plugin-worker-spawn-spec'

const roots: string[] = []
const controllers: PluginWorkerController[] = []
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function plugin(): Promise<ValidDiscoveredPlugin> {
  const rootDir = await mkdtemp(join(tmpdir(), 'orca-worker-release-'))
  roots.push(rootDir)
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 2,
    execution: 'trusted-worker',
    id: 'worker',
    publisher: 'orca-samples',
    name: 'Worker',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    main: 'main.mjs',
    contributes: {},
    capabilities: []
  })
  await writeFile(join(rootDir, 'orca-plugin.json'), JSON.stringify(manifest))
  await writeFile(join(rootDir, 'main.mjs'), 'export default function activate() {}')
  const discovered = { pluginKey: 'orca-samples.worker', rootDir, manifest, isDev: true }
  return { ...discovered, contentHash: null, ...(await discoverPluginConsent(discovered)) }
}

function setup() {
  let exit: ((code: number | null) => void) | undefined
  const handle: PluginWorkerHandle = {
    commands: [],
    invokeCommand: vi.fn(async () => null),
    deliverEvent: vi.fn(),
    lastActivityAt: () => Date.now(),
    inFlightCount: () => 0,
    dispose: vi.fn(async () => undefined),
    kill: vi.fn(),
    onExit: (callback) => {
      exit = callback
    }
  }
  const factory = vi.fn(async () => handle)
  const subject = new PluginWorkerController({
    entryPath: '/host.js',
    workerFactory: factory,
    contentVerifier: new PluginContentVerifier(),
    registry: createPluginExtensionRegistry(),
    capabilities: () => [],
    isCurrentApproved: () => true,
    invokeCommand: vi.fn(async () => null),
    executeHostCall: vi.fn(async () => ({ ok: true as const, value: null })),
    log: () => vi.fn(),
    onStateChanged: vi.fn(),
    onWorkerGone: vi.fn()
  })
  controllers.push(subject)
  return { subject, factory, crash: () => exit?.(1) }
}

describe('trusted worker exact release admission', () => {
  it('rejects changed dev code even before discovery refreshes its approval cache', async () => {
    const reviewed = await plugin()
    const { subject, factory } = setup()
    await writeFile(join(reviewed.rootDir, 'main.mjs'), 'throw new Error("unreviewed")')
    await expect(subject.ensure(reviewed)).rejects.toThrow('changed since its release was reviewed')
    expect(factory).not.toHaveBeenCalled()
  })

  it('rechecks the reviewed bytes before an automatic crash restart', async () => {
    const reviewed = await plugin()
    const { subject, factory, crash } = setup()
    await subject.ensure(reviewed)
    await writeFile(
      join(reviewed.rootDir, 'main.mjs'),
      'throw new Error("changed after activation")'
    )
    crash()
    await vi.waitFor(() => expect(subject.state(reviewed.pluginKey).restarts).toBeGreaterThan(1), {
      timeout: 2000
    })
    expect(factory).toHaveBeenCalledOnce()
  })

  it('does not reuse a running worker across an approved same-manifest content change', async () => {
    const reviewed = await plugin()
    await writeFile(join(reviewed.rootDir, 'main.mjs'), 'export default function changed() {}')
    const next = { ...reviewed, ...(await discoverPluginConsent(reviewed)) }
    expect(
      pluginWorkerSpawnSpecsEqual(
        buildPluginWorkerSpawnSpec(reviewed, []),
        buildPluginWorkerSpawnSpec(next, [])
      )
    ).toBe(false)
  })
})
