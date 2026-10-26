import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoMaintenanceIdleInputs } from '../repo-maintenance-host-idle-gate'

const { install, uninstall } = vi.hoisted(() => ({
  install: vi.fn<(inputs: RepoMaintenanceIdleInputs) => () => Promise<void>>(),
  uninstall: vi.fn(async () => {})
}))
vi.mock('../repo-maintenance-host-idle-gate', () => ({
  installRepoMaintenanceHostIdleGate: install
}))

import { installOrcadRepoMaintenance } from './orcad-repo-maintenance'

beforeEach(() => {
  vi.clearAllMocks()
  install.mockReturnValue(uninstall)
})

describe('remote execution-host maintenance', () => {
  it('allows connected idle clients while deferring for agents, requests and migration', async () => {
    let states = [{ state: 'idle' }]
    let requestsInFlight = 0
    let staged = false
    const stop = installOrcadRepoMaintenance(
      { readClientActivity: () => ({ openConnections: 2, requestsInFlight, lastRequestAt: 0 }) },
      { getStatusSnapshot: () => states },
      { hasStagedOrcadMigrationCatalog: () => staged }
    )
    const inputs = install.mock.calls[0]?.[0]
    expect(inputs?.getWorkingAgentCount()).toBe(0)
    expect(inputs?.isBusy?.()).toBe(false)
    states = [{ state: 'working' }, { state: 'idle' }]
    expect(inputs?.getWorkingAgentCount()).toBe(1)
    requestsInFlight = 1
    expect(inputs?.isBusy?.()).toBe(true)
    requestsInFlight = 0
    staged = true
    expect(inputs?.isBusy?.()).toBe(true)
    expect(inputs?.isQuitting()).toBe(false)
    uninstall.mockImplementationOnce(async () => {
      expect(inputs?.isQuitting()).toBe(true)
    })
    await stop()
    expect(uninstall).toHaveBeenCalledOnce()
  })
})
