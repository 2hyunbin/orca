import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { runCodexAppServerSession, type CodexAppServerRpc } from './codex-app-server-session'
import { randomUUID } from 'node:crypto'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import type {
  CodexSession,
  CodexStructuredSessionAdapterDeps
} from './codex-structured-session-state'

const RENAME_TIMEOUT_MS = 15_000
// Older Codex refuses a name until the thread's first record reaches disk; give a fresh
// conversation two short chances, then leave the name for the user's next rename.
const EMPTY_ROLLOUT = /\brollout at .+ is empty\b/i
const EMPTY_ROLLOUT_RETRY_DELAYS_MS = [50, 200] as const

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function setThreadName(
  request: CodexAppServerRpc['request'],
  threadId: string,
  name: string
): Promise<void> {
  for (const delay of EMPTY_ROLLOUT_RETRY_DELAYS_MS) {
    try {
      await request('thread/name/set', { threadId, name }, { timeoutMs: RENAME_TIMEOUT_MS })
      return
    } catch (error) {
      if (!(error instanceof Error) || !EMPTY_ROLLOUT.test(error.message)) {
        throw error
      }
      await wait(delay)
    }
  }
  await request('thread/name/set', { threadId, name }, { timeoutMs: RENAME_TIMEOUT_MS })
}

/** Codex's own /rename is `thread/name/set`. It names an unloaded thread straight in the
 *  account's thread store, so a chat at rest takes it from a short-lived app-server without
 *  resuming the thread. */
export async function renameCodexProviderSession(input: {
  session: CodexSession | undefined
  record: AgentSessionRecord
  providerSessionId: string
  name: string
  resolveLaunch: CodexStructuredSessionAdapterDeps['resolveLaunch']
}): Promise<void> {
  const { session, providerSessionId, name } = input
  const live = session && !session.ended && !session.connection.closed ? session : null
  if (live?.threadId === providerSessionId) {
    await setThreadName(
      (method, params, options) => live.connection.request(method, params, options),
      providerSessionId,
      name
    )
    return
  }
  const codexHome = requireLegacyAgentSessionAccountHome(input.record.accountHome).path
  const { record } = input
  const launch = await input.resolveLaunch({
    identity: {
      sessionId: record.sessionId,
      workspaceId: record.location.workspaceId,
      hostId: record.location.executionHostId,
      agent: 'codex',
      providerHandle:
        agentSessionProviderHandleChainHead(record.providerHandleChain)?.handle ?? null
    },
    spawnToken: randomUUID()
  })
  await runCodexAppServerSession(
    {
      command: launch.command,
      args: [...launch.args.slice(0, -1), ...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS],
      cwd: launch.cwd,
      cliPath: launch.command,
      env: { ...launch.env, CODEX_HOME: codexHome },
      envToDelete: launch.envToDelete,
      timeoutMs: RENAME_TIMEOUT_MS
    },
    (rpc) => setThreadName(rpc.request, providerSessionId, name)
  )
}
