import { AiVaultScannerServiceClient } from './session-scanner-service-client'
import { spawnAiVaultServiceProcess } from './session-scanner-service-spawn'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { SelectedSessionFileRequest } from './selected-session-file-reader'

// Selected reads never inherit the discovery process's queue, cache hydration or index work.
const reader = new AiVaultScannerServiceClient({
  processFactory: spawnAiVaultServiceProcess,
  init: () => ({ sessionParseCache: null, sessionSearch: null }),
  idleTimeoutMs: 60_000,
  onStderr: (text) => console.error('[selected-session-reader]', text.trimEnd())
})

export function readSelectedSessionInBackground(
  request: SelectedSessionFileRequest,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  return reader.request({ type: 'request', operation: 'selectedSession', request }, signal)
}
