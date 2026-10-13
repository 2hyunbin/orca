import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { vi } from 'vitest'
import { SshConnectionStore } from '../ssh/ssh-connection-store'
import { createMockStore } from '../ssh/ssh-connection-store-test-fixture'
import { setSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { createPluginEnvironmentProviderInstallFixture } from './plugin-environment-provider-install-fixture'

export const providerFixtureConnection = {
  type: 'ssh' as const,
  host: 'box.internal',
  port: 22,
  username: 'developer',
  projectRoot: '/projects'
}
export async function createProviderSshFixture(
  options: NonNullable<Parameters<typeof createPluginEnvironmentProviderInstallFixture>[0]> = {}
) {
  const f = await createPluginEnvironmentProviderInstallFixture(options)
  await f.approve()
  await f.service.environmentProviders.configure(f.review)
  const resource = {
    id: 'devbox',
    name: 'Existing devbox',
    revision: 'r1',
    lifetime: 'long-lived' as const,
    state: 'running' as const,
    connection: providerFixtureConnection
  }
  await writeFile(join(f.cwd, 'backend.json'), JSON.stringify({ devbox: resource }))
  const persisted = { ...createMockStore(), flushPendingOrThrowAsync: vi.fn(async () => {}) }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture implements the persistence operations exercised by SSH target registration and durable flush.
  const store = new SshConnectionStore(persisted as never)
  setSshTargetRegistryStore(store)
  return { ...f, store, persisted, resource, ssh: f.service.environmentProviders.ssh }
}
