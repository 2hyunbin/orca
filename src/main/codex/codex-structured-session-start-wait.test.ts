import { describe, expect, it, vi } from 'vitest'

import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import type { CodexAppServerConnection } from './codex-app-server-connection-types'
import { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}

describe('Codex start wait', () => {
  it('waits on a slow resume with no deadline until the host ends the start', async () => {
    const resumeOptions: unknown[] = []
    const close = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
    const connection: CodexAppServerConnection = {
      pid: 4321,
      closed: false,
      request: (method, _params, options) => {
        if (method !== 'thread/resume') {
          return Promise.resolve({})
        }
        resumeOptions.push(options)
        return new Promise<never>(() => {})
      },
      notify: () => undefined,
      respond: () => undefined,
      respondWithError: () => undefined,
      close
    }
    const openHandlers: { signal?: AbortSignal }[] = []
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: '/work/repo',
        codexHome: null,
        resumeThreadId: 'thread-1'
      }),
      openConnection: async (_launch, handlers) => {
        openHandlers.push(handlers ?? {})
        return connection
      },
      readProcessStartTime: async () => 1_700_000_000_000
    })
    const startLimit = new AbortController()

    const acquiring = adapter
      .acquire({ identity: IDENTITY, fence: 7, spawnToken: 'spawn-9', signal: startLimit.signal })
      .catch((error: unknown) => error)
    await vi.waitFor(() => expect(resumeOptions).toHaveLength(1))

    expect(resumeOptions[0]).toMatchObject({ timeoutMs: null })
    expect(openHandlers[0]?.signal).toBe(startLimit.signal)
    expect(close).not.toHaveBeenCalled()

    startLimit.abort(new Error('codex never finished starting'))
    expect(await acquiring).toMatchObject({ message: 'codex never finished starting' })
    expect(close).toHaveBeenCalled()
  })
})
