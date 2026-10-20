import { vi } from 'vitest'
import type * as ModelCatalogDiscovery from './structured-agent-model-catalog-discovery'
import type { AgentModelCatalogDiscovery } from '../native-chat/agent-model-catalog/agent-model-catalog-discovery'

/** Independent discovery for a scripted Codex transport, without starting another process. */
export function scriptedCodexModelCatalogDiscovery(): AgentModelCatalogDiscovery {
  return {
    kind: 'probe',
    listingNamesConfiguredModel: true,
    probe: async () => ({
      origin: 'probe',
      complete: true,
      models: [
        {
          id: 'gpt-live',
          label: 'GPT Live',
          isDefault: true,
          defaultEffort: 'medium',
          efforts: [
            { value: 'medium', label: 'Balanced' },
            { value: 'high', label: 'Deep reasoning' }
          ]
        }
      ]
    })
  }
}

vi.mock('./structured-agent-model-catalog-discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelCatalogDiscovery>()),
  codexModelCatalogDiscovery: () => scriptedCodexModelCatalogDiscovery()
}))
