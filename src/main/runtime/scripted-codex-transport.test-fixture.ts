import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  openCodexAppServerConnection
} from '../codex/codex-app-server-connection'
import {
  CODEX_MINIMUM_SUPPORTED_VERSION,
  codexCliInstallation
} from '../../shared/codex-cli-installation'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime'

/** Runtime deps that put a scripted Codex child where the real app-server would spawn. It speaks
 *  the supported protocol, so it reports that version; its fake pid has a fixed start time. */
export function scriptedCodexTransport(
  openConnection: NonNullable<StructuredAgentSessionRuntimeDeps['openCodexConnection']>
): Pick<
  StructuredAgentSessionRuntimeDeps,
  'openCodexConnection' | 'readCodexInstallation' | 'readProcessStartTime'
> {
  return {
    openCodexConnection: openConnection,
    readCodexInstallation: async () => codexCliInstallation(true, CODEX_MINIMUM_SUPPORTED_VERSION),
    readProcessStartTime: async () => 1_700_000_000_000
  }
}

export type CodexScript = {
  connections: FakeConnection[]
  openConnection: typeof openCodexAppServerConnection
  live: () => FakeConnection
  notify: (method: string, params: unknown) => void
  ask: (id: number, method: string, params: unknown) => void
}

// `closed` is readonly on the real connection; the fake flips it so the test can
// see the takeover reap the previous child.
type FakeConnection = Omit<CodexAppServerConnection, 'closed'> & {
  closed: boolean
  handlers: CodexAppServerConnectionHandlers
  calls: { method: string; params?: Record<string, unknown> }[]
  replies: { id: number | string; result?: unknown; code?: number }[]
  resumedThreadId: string | null
  launch: Parameters<typeof openCodexAppServerConnection>[0]
}

export function scriptedCodexAppServer(threadId: string, turnId: string): CodexScript {
  const connections: FakeConnection[] = []
  const openConnection: typeof openCodexAppServerConnection = async (launch, handlers = {}) => {
    const connection: FakeConnection = {
      launch,
      handlers,
      calls: [],
      replies: [],
      resumedThreadId: null,
      pid: 4321,
      closed: false,
      request: async (method, params) => {
        connection.calls.push({ method, params })
        if (method === 'thread/start') {
          return {
            thread: { id: threadId, path: '/rollouts/integration.jsonl' },
            model: 'gpt-live',
            reasoningEffort: 'medium'
          }
        }
        if (method === 'thread/resume') {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: integration sends schema-validated thread/resume parameters.
          connection.resumedThreadId = (params as { threadId: string }).threadId
          return {
            thread: { id: connection.resumedThreadId },
            model: 'gpt-live',
            reasoningEffort: 'medium'
          }
        }
        if (method === 'turn/start') {
          return { turn: { id: turnId } }
        }
        return {}
      },
      notify: () => {},
      respond: (id, result) => connection.replies.push({ id, result }),
      respondWithError: (id, code) => connection.replies.push({ id, code }),
      close: async () => {
        connection.closed = true
        return true
      }
    }
    connections.push(connection)
    return connection
  }
  const live = (): FakeConnection => {
    const connection = connections.at(-1)
    if (!connection) {
      throw new Error('no codex app-server has been opened')
    }
    return connection
  }
  return {
    connections,
    openConnection,
    live,
    notify: (method, params) => live().handlers.onNotification?.(method, params),
    ask: (id, method, params) => live().handlers.onServerRequest?.({ id, method, params })
  }
}
