import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoMaintenanceIdleInputs } from '../repo-maintenance-host-idle-gate'
import { REF_MAINTENANCE_QUIET_PERIOD_MS } from '../../shared/repo-ref-maintenance-policy'

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

afterEach(() => vi.restoreAllMocks())

describe('remote execution-host maintenance', () => {
  it('waits a full quiet window after terminal input or a completed request', async () => {
    const now = REF_MAINTENANCE_QUIET_PERIOD_MS * 3
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    let lastRequestAt = now
    let requestsInFlight = 0
    const stop = installOrcadRepoMaintenance(
      { readClientActivity: () => ({ openConnections: 2, requestsInFlight, lastRequestAt }) },
      { hasWorkingAgent: () => false },
      { hasStagedOrcadMigrationCatalog: () => false }
    )
    const inputs = install.mock.calls[0]?.[0]
    expect(inputs?.isBusy?.()).toBe(true)
    clock.mockReturnValue(now + REF_MAINTENANCE_QUIET_PERIOD_MS - 1)
    expect(inputs?.isBusy?.()).toBe(true)
    clock.mockReturnValue(now + REF_MAINTENANCE_QUIET_PERIOD_MS)
    expect(inputs?.isBusy?.()).toBe(false)
    requestsInFlight = 1
    expect(inputs?.isBusy?.()).toBe(true)
    requestsInFlight = 0
    lastRequestAt = Date.now()
    expect(inputs?.isBusy?.()).toBe(true)
    clock.mockReturnValue(Date.now() + REF_MAINTENANCE_QUIET_PERIOD_MS)
    expect(inputs?.isBusy?.()).toBe(false)
    lastRequestAt = Number.NaN
    expect(inputs?.isBusy?.()).toBe(true)
    await stop()
  })

  it('allows connected idle clients while deferring for agents, requests and migration', async () => {
    let working = false
    let requestsInFlight = 0
    let staged = false
    const stop = installOrcadRepoMaintenance(
      { readClientActivity: () => ({ openConnections: 2, requestsInFlight, lastRequestAt: 0 }) },
      { hasWorkingAgent: () => working },
      { hasStagedOrcadMigrationCatalog: () => staged }
    )
    const inputs = install.mock.calls[0]?.[0]
    expect(inputs?.getWorkingAgentCount()).toBe(0)
    expect(inputs?.isBusy?.()).toBe(false)
    working = true
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
