import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

type Handler = (event: unknown, args: unknown) => unknown
const { handlers, connect, getPath } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  connect: vi.fn(),
  getPath: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath },
  ipcMain: {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: vi.fn()
  }
}))
vi.mock('../ephemeral-vm-runtime-ssh', () => ({
  connectRuntimeOwnedSshTarget: connect,
  disconnectRuntimeOwnedSshTarget: vi.fn(),
  removeRuntimeOwnedSshTarget: vi.fn()
}))
vi.mock('./runtime-environments', () => ({ invalidateRuntimeEnvironmentTransport: vi.fn() }))

import type { Store } from '../persistence'
import { registerEphemeralVmHandlers } from './ephemeral-vm'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

it("records the managed server that serves a recipe VM's SSH host", async () => {
  const userDataPath = tempDir('orca-vm-managed-user-data-')
  const repoPath = tempDir('orca-vm-managed-repo-')
  getPath.mockReturnValue(userDataPath)
  const startPath = join(repoPath, 'start.js')
  const result = {
    schemaVersion: 1,
    connection: {
      type: 'ssh',
      projectRoot: '/workspace/repo',
      target: { label: 'Sandbox', host: 'sandbox.example.com', port: 22, username: 'root' }
    }
  }
  writeFileSync(startPath, `console.log(${JSON.stringify(JSON.stringify(result))})`)
  writeFileSync(
    join(repoPath, 'orca.yaml'),
    [
      'environmentRecipes:',
      '  - id: cloud-sandbox',
      '    name: Cloud Sandbox',
      `    create: ${JSON.stringify(`"${process.execPath}" "${startPath}"`)}`,
      '    destroy: none'
    ].join('\n')
  )
  connect.mockImplementation(async ({ runtimeId }: { runtimeId: string }) => ({
    targetId: `runtime-ssh-${runtimeId}`,
    target: { id: `runtime-ssh-${runtimeId}` },
    environmentId: 'env-managed-vm'
  }))
  const repo = { id: 'repo-1', path: repoPath, displayName: 'Repo', badgeColor: '#000', addedAt: 0 }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: provisioning reads only getRepo, getRepos and getSettings.
  const store = {
    getRepo: (id: string) => (id === repo.id ? repo : null),
    getRepos: () => [repo],
    getSettings: () => ({})
  } as unknown as Store

  registerEphemeralVmHandlers(store)
  const provisioned = await handlers.get('ephemeralVm:provision')?.(null, {
    repoId: 'repo-1',
    recipeId: 'cloud-sandbox'
  })

  expect(provisioned).toMatchObject({
    ok: true,
    connectionType: 'ssh',
    environmentId: 'env-managed-vm',
    runtime: { connectionMode: 'ssh', runtimeEnvironmentId: 'env-managed-vm' }
  })
})
