import { expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import {
  ephemeralVmCleanup,
  ephemeralVmListRuntimes,
  installReposRuntimeRoutingHarness,
  reposRemoveForHost,
  runtimeEnvironmentCall,
  sshRepo
} from './repos-runtime-routing-fixture'
import { createTestStore } from './store-test-helpers'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  }
}))

installReposRuntimeRoutingHarness()

it('retains a runtime-owned SSH project when VM cleanup fails', async () => {
  const runtimeRepo: Repo = { ...sshRepo, connectionId: 'runtime-ssh-runtime-1' }
  ephemeralVmListRuntimes.mockResolvedValue([
    {
      id: 'runtime-1',
      cleanupStatus: 'not_started',
      sshTargetId: runtimeRepo.connectionId
    }
  ])
  ephemeralVmCleanup.mockResolvedValue({
    status: 'cleanup_failed',
    cleanupStatus: 'failed',
    sshTargetId: runtimeRepo.connectionId
  })
  const store = createTestStore()
  store.setState({ repos: [runtimeRepo], activeRepoId: runtimeRepo.id })

  await store.getState().removeProject(runtimeRepo.id, {
    hostId: getRepoExecutionHostId(runtimeRepo),
    errorFeedback: 'toast'
  })

  expect(store.getState().repos).toEqual([runtimeRepo])
  expect(reposRemoveForHost).not.toHaveBeenCalled()
  expect(toast.error).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ description: expect.stringContaining('Retry cleanup') })
  )
})

const vmServerRepo: Repo = {
  ...sshRepo,
  id: 'vm-repo',
  connectionId: null,
  executionHostId: 'runtime:env-vm'
}
const vmServer: PublicKnownRuntimeEnvironment = {
  id: 'env-vm',
  name: 'Docker root VM',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [
    { id: 'ws', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://127.0.0.1:41000' }
  ],
  preferredEndpointId: 'ws',
  orcadDeployment: {
    sshTargetId: 'runtime-ssh-runtime-1',
    sshTargetGeneration: 1,
    localPort: 41_000,
    remotePort: 6768
  }
}

it('destroys a recipe VM whose managed server holds the project, without asking the gone server', async () => {
  ephemeralVmListRuntimes.mockResolvedValue([
    { id: 'runtime-1', cleanupStatus: 'not_started', sshTargetId: 'runtime-ssh-runtime-1' }
  ])
  ephemeralVmCleanup.mockResolvedValue({ status: 'cleaned', cleanupStatus: 'succeeded' })
  const store = createTestStore()
  store.setState({
    repos: [vmServerRepo],
    runtimeEnvironments: [vmServer]
  })

  await store.getState().removeProject(vmServerRepo.id, {
    hostId: 'runtime:env-vm',
    errorFeedback: 'toast'
  })

  expect(ephemeralVmCleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
  expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
    expect.objectContaining({ method: 'repo.rm' })
  )
  expect(store.getState().repos).toEqual([])
})

it("retains a recipe VM's managed-server project when VM cleanup fails", async () => {
  ephemeralVmListRuntimes.mockResolvedValue([
    { id: 'runtime-1', cleanupStatus: 'not_started', sshTargetId: 'runtime-ssh-runtime-1' }
  ])
  ephemeralVmCleanup.mockResolvedValue({
    status: 'cleanup_failed',
    cleanupStatus: 'failed',
    sshTargetId: 'runtime-ssh-runtime-1'
  })
  const store = createTestStore()
  store.setState({ repos: [vmServerRepo], runtimeEnvironments: [vmServer] })

  await store.getState().removeProject(vmServerRepo.id, {
    hostId: 'runtime:env-vm',
    errorFeedback: 'toast'
  })

  expect(store.getState().repos).toEqual([vmServerRepo])
})
