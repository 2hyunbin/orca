import { vi } from 'vitest'
import type * as ProviderProcessLedger from './provider-process-ledger'
import type * as ProviderProcessGroup from './provider-process-group'

// Scripted children have no OS group; every group/record operation stays in this fixture.

vi.mock('./provider-process-ledger', async (original) => ({
  ...(await original<typeof ProviderProcessLedger>()),
  recordProviderLaunch: () => ({
    capture: async () => {},
    retire: async () => {},
    members: () => []
  })
}))
vi.mock('./provider-process-group', async (original) => ({
  ...(await original<typeof ProviderProcessGroup>()),
  signalProviderGroup: vi.fn(),
  observeProviderGroup: async () => 'exited',
  stopRecordedProviderGroup: async () => 'exited'
}))
