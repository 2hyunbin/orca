import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(),
  removeManaged: vi.fn(),
  closeTunnel: vi.fn(async () => {})
}))

vi.mock('../shared/runtime-environment-store', () => ({
  listEnvironments: mocks.list,
  removeEnvironment: mocks.remove
}))
vi.mock('../shared/runtime-environment-managed-orcad-store', () => ({
  removeManagedOrcadEnvironment: mocks.removeManaged
}))
vi.mock('./ssh/orcad-managed-tunnel', () => ({ closeOrcadManagedTunnel: mocks.closeTunnel }))

import { releaseEphemeralVmRuntimeEnvironment } from './ephemeral-vm-runtime-environment-release'

describe('releaseEphemeralVmRuntimeEnvironment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("closes a destroyed VM's managed server tunnel and forgets the server", async () => {
    mocks.list.mockReturnValue([
      { id: 'env-vm', orcadDeployment: { sshTargetId: 'runtime-ssh-vm' } }
    ])
    await releaseEphemeralVmRuntimeEnvironment('/user-data', 'env-vm')
    expect(mocks.closeTunnel).toHaveBeenCalledWith('env-vm')
    expect(mocks.removeManaged).toHaveBeenCalledWith('/user-data', 'env-vm')
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it('removes a paired recipe server the ordinary way', async () => {
    mocks.list.mockReturnValue([{ id: 'env-paired' }])
    await releaseEphemeralVmRuntimeEnvironment('/user-data', 'env-paired')
    expect(mocks.remove).toHaveBeenCalledWith('/user-data', 'env-paired')
    expect(mocks.closeTunnel).not.toHaveBeenCalled()
  })

  it('ignores a server that is already gone', async () => {
    mocks.list.mockReturnValue([])
    await releaseEphemeralVmRuntimeEnvironment('/user-data', 'env-gone')
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.removeManaged).not.toHaveBeenCalled()
  })
})
