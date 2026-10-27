import { expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import * as appServer from './codex-app-server-session'
import { renameCodexProviderSession } from './codex-provider-session-rename'
import type { CodexSession } from './codex-structured-session-state'

it("renames the running thread the way Codex's own /rename does, waiting out an unwritten rollout", async () => {
  const request = vi
    .fn()
    .mockRejectedValueOnce(
      new Error('failed to set thread name: rollout at /home/work/.codex/sessions/x.jsonl is empty')
    )
    .mockResolvedValue({})
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rename reads only ended, threadId and the connection's closed flag and request.
  const session = {
    ended: false,
    threadId: 'thread-1',
    connection: { closed: false, request }
  } as unknown as CodexSession

  await renameCodexProviderSession({
    session,
    resolveLaunch: vi.fn(),
    record: agentSessionRecordFixture({ provider: 'codex' }),
    providerSessionId: 'thread-1',
    name: 'Release notes'
  })

  expect(request).toHaveBeenCalledTimes(2)
  expect(request).toHaveBeenLastCalledWith(
    'thread/name/set',
    { threadId: 'thread-1', name: 'Release notes' },
    { timeoutMs: 15_000 }
  )
})

it('keeps the configured idle command/env/account and propagates failure', async () => {
  const request = vi.fn().mockRejectedValue(new Error('thread not found'))
  const run = vi
    .spyOn(appServer, 'runCodexAppServerSession')
    .mockImplementation(async (_invocation, body) => body({ request, notify: vi.fn() }))
  const resolveLaunch = vi.fn(async () => ({
    command: '/tools/cx',
    args: ['--profile', 'work', 'app-server'],
    cwd: '/work/repo',
    codexHome: '/wrong',
    resumeThreadId: 'thread-1',
    env: { PATH: '/tools', CUSTOM: 'value' }
  }))
  try {
    await expect(
      renameCodexProviderSession({
        session: undefined,
        resolveLaunch,
        record: agentSessionRecordFixture({
          sessionId: 'chat-1',
          provider: 'codex',
          accountHome: { variable: 'CODEX_HOME', path: '/saved/account' }
        }),
        providerSessionId: 'thread-1',
        name: 'Release notes'
      })
    ).rejects.toThrow('thread not found')
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      command: '/tools/cx',
      cwd: '/work/repo',
      env: { PATH: '/tools', CUSTOM: 'value', CODEX_HOME: '/saved/account' }
    })
    expect(run.mock.calls[0]?.[0].args).toContain('features.plugins=false')
    expect(request).toHaveBeenCalledWith(
      'thread/name/set',
      { threadId: 'thread-1', name: 'Release notes' },
      { timeoutMs: 15_000 }
    )
  } finally {
    run.mockRestore()
  }
})
