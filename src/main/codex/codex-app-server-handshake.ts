import type { CodexAppServerConnection } from './codex-app-server-connection-types'

/** No deadline of its own: a cold Codex can take its time, and the start that opened it bounds
 *  the wait with its signal. */
export async function initializeCodexAppServerConnection(
  connection: CodexAppServerConnection
): Promise<void> {
  await connection.request(
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
  )
  connection.notify('initialized')
}
