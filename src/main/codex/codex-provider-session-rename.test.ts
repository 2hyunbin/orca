import { expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
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
    record: agentSessionRecordFixture({
      sessionId: 'chat-1',
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: '/home/work/.codex' }
    }),
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
