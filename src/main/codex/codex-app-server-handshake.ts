import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { CodexAppServerConnection } from './codex-app-server-connection-types'

/** No deadline of its own: a cold Codex can take its time, and the start that opened it owns how
 *  long that may be (`signal`). */
export async function initializeCodexAppServerConnection(
  connection: CodexAppServerConnection,
  signal?: AbortSignal
): Promise<void> {
  await waitForPromiseWithSignal(
    connection.request(
      'initialize',
      {
        clientInfo: { name: 'orca_desktop', title: 'Orca', version: '0.0.0' },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
          extensions: {}
        }
      },
      { timeoutMs: null }
    ),
    signal
  )
  connection.notify('initialized')
}
