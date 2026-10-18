// Rewind against the real CLI: Orca cuts a Claude chat by forking its conversation at the rewound
// prompt's parent with the SDK's truncating resume. Pins the provider contract that design relies
// on: the prompt id Orca sends is the transcript's, the fork forgets the undone turn, and the
// rewound conversation is left as it was.

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import {
  realClaudeAuthenticated,
  realClaudeAvailable,
  realClaudeCommand,
  realClaudeLaunchHome
} from './claude-real-cli-availability-test-support'
import { readClaudePromptParentUuid } from './claude-rewind-fork'
import {
  CLAUDE_STRUCTURED_BASE_OPTIONS,
  type ClaudeStructuredSdkOptions
} from './claude-structured-launch-resolution'
import {
  ClaudeStructuredSessionAdapter,
  type ClaudeStructuredSessionEvent
} from './claude-structured-session-adapter'
import { claudeStartupSettled } from './claude-structured-session-test-support'

const SESSION_ID = 'real-cli-rewind'

function identity(providerSessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId: SESSION_ID,
    workspaceId: 'real-cli-rewind-workspace',
    hostId: 'local',
    agent: 'claude',
    providerHandle: claudeProviderHandle(providerSessionId, null)
  }
}

function turnResults(events: readonly ClaudeStructuredSessionEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'message' &&
    event.message.type === 'result' &&
    typeof event.message.result === 'string'
      ? [event.message.result]
      : []
  )
}

async function transcriptUuids(providerSessionId: string, claudeConfigDir: string) {
  const path = await resolveSessionFilePath('claude', providerSessionId, {
    claudeProjectsDir: join(claudeConfigDir, 'projects')
  })
  const rows = (await readFile(path ?? '', 'utf8')).trim().split('\n')
  return rows.flatMap((line): string[] => {
    const row: unknown = JSON.parse(line)
    return row && typeof row === 'object' && 'uuid' in row && typeof row.uuid === 'string'
      ? [row.uuid]
      : []
  })
}

describe.skipIf(!realClaudeAvailable)('Claude structured real CLI rewind', () => {
  it.skipIf(!realClaudeAuthenticated)(
    'forks the conversation at the rewound prompt and forgets the undone turn',
    async () => {
      const source = randomUUID()
      const fork = randomUUID()
      const { claudeConfigDir, env } = realClaudeLaunchHome()
      const cwd = await mkdtemp(join(tmpdir(), 'orca-real-rewind-'))
      const events: ClaudeStructuredSessionEvent[] = []
      // The CLI's replay of a send settles it after `dispatch` answers, with the prompt's own id.
      const promptIds = new Map<string, string>()
      const adapterFor = (providerSessionId: string, launch: ClaudeStructuredSdkOptions) =>
        new ClaudeStructuredSessionAdapter({
          resolveLaunch: async () => ({
            pathToClaudeCodeExecutable: realClaudeCommand,
            options: { ...CLAUDE_STRUCTURED_BASE_OPTIONS, ...launch },
            cwd,
            env,
            claudeConfigDir,
            providerSessionId,
            resumeLeafUuid: null,
            resumesTranscript: false,
            continuesChain: false
          }),
          onEvent: (event) => events.push(event),
          onDispatchSettledLate: (settled) => {
            if ('providerIdentity' in settled && settled.providerIdentity.provider === 'claude') {
              promptIds.set(settled.clientMessageId, settled.providerIdentity.uuid)
            }
          },
          readProcessStartTime: async () => 1
        })
      const send = async (adapter: ClaudeStructuredSessionAdapter, text: string, n: number) => {
        const clientMessageId = `real-cli-rewind-${n}`
        const sent = await adapter.dispatch({
          sessionId: SESSION_ID,
          clientMessageId,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
          requestedAt: Date.now(),
          fence: 1
        })
        await vi.waitFor(() => expect(turnResults(events)).toHaveLength(n), {
          timeout: 90_000,
          interval: 250
        })
        if (sent.state === 'accepted' && sent.providerIdentity?.provider === 'claude') {
          return sent.providerIdentity.uuid
        }
        return promptIds.get(clientMessageId)
      }

      const first = adapterFor(source, { sessionId: source })
      let promptUuid: string | undefined
      try {
        await first.acquire({ identity: identity(source), fence: 1, spawnToken: 'rewind-source' })
        await claudeStartupSettled(first, SESSION_ID)
        await send(first, 'Reply with the single word ALPHA and nothing else.', 1)
        promptUuid = await send(first, 'Reply with the single word BRAVO and nothing else.', 2)
      } finally {
        await first.closeAll()
      }

      const sourceBefore = await transcriptUuids(source, claudeConfigDir)
      // Orca's prompt id is the transcript's, so the rewound row maps to its cut.
      expect(sourceBefore).toContain(promptUuid)
      const throughEntryId = await readClaudePromptParentUuid({
        providerSessionId: source,
        promptUuid: promptUuid ?? '',
        claudeConfigDir
      })
      expect(throughEntryId).toEqual(expect.any(String))

      const rewound = adapterFor(fork, {
        sessionId: fork,
        resume: source,
        resumeSessionAt: throughEntryId ?? '',
        forkSession: true
      })
      try {
        await rewound.acquire({ identity: identity(fork), fence: 1, spawnToken: 'rewind-fork' })
        await claudeStartupSettled(rewound, SESSION_ID)
        await send(
          rewound,
          'List every word I have asked you to reply with in this conversation, in capitals.',
          3
        )
      } finally {
        await rewound.closeAll()
      }

      const answer = turnResults(events)[2] ?? ''
      expect(answer).toContain('ALPHA')
      expect(answer).not.toContain('BRAVO')
      // The fork keeps the kept entries' ids, and the rewound conversation is untouched.
      const forked = await transcriptUuids(fork, claudeConfigDir)
      expect(forked).toContain(throughEntryId)
      expect(forked).not.toContain(promptUuid)
      expect(await transcriptUuids(source, claudeConfigDir)).toEqual(sourceBefore)
    },
    240_000
  )
})
