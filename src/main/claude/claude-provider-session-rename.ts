import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { appendFile, open } from 'node:fs/promises'
import { join } from 'node:path'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { getClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import type { ClaudeSession } from './claude-structured-session-state'
import { loadClaudeAgentSdk } from './claude-stream-json-connection'

/** A running CLI saves the name itself (transcript line, title sidecar, its own memory). At rest,
 *  the SDK's rename writes Claude's `custom-title` line; a running CLI would re-append its
 *  remembered title over an outside line, so that path is only for a conversation Orca isn't
 *  running. */
export async function renameClaudeProviderSession(input: {
  session: ClaudeSession | undefined
  record: AgentSessionRecord
  providerSessionId: string
  name: string
  timeoutMs: number | undefined
}): Promise<void> {
  const { session, providerSessionId, name } = input
  if (session && !session.connection.closed && session.providerSessionId === providerSessionId) {
    await session.connection.renameSession(
      name,
      providerSessionId,
      input.timeoutMs === undefined ? undefined : { timeoutMs: input.timeoutMs }
    )
    return
  }
  if (session?.providerSessionId === providerSessionId) {
    await session.closeFinalization
    if (session.connection.exitVerdict.root !== 'exited') {
      throw new Error('the Claude conversation still has an unproven transcript writer')
    }
  }
  const transcript = await findClaudeTranscript(input.record, providerSessionId)
  if (!transcript) {
    throw new Error('the Claude conversation has no transcript to name')
  }
  const { renameSession } = await loadClaudeAgentSdk()
  // Pin the write to the transcript found above without mutating process.env.
  await renameSession(providerSessionId, name, {
    sessionStore: {
      load: async () => null,
      append: (_key, entries) => appendTranscriptEntries(transcript, entries)
    }
  })
}

/** The chat's account may have changed since this conversation was written, as for rewind. */
async function findClaudeTranscript(
  record: AgentSessionRecord,
  providerSessionId: string
): Promise<string | null> {
  const router = getClaudeProfileRouter()
  const homes = new Set([
    requireLegacyAgentSessionAccountHome(record.accountHome).path,
    ...(router ? [...router.accountHomes(), router.systemDefaultHome()] : [])
  ])
  for (const home of homes) {
    const path = await resolveSessionFilePath('claude', providerSessionId, {
      claudeProjectsDir: join(home, 'projects')
    })
    if (path) {
      return path
    }
  }
  return null
}

/** Starts on a fresh line, so a crash-torn last line can't swallow the title. */
export async function appendTranscriptEntries(
  path: string,
  entries: readonly SessionStoreEntry[]
): Promise<void> {
  const handle = await open(path, 'r')
  let separator = ''
  try {
    const { size } = await handle.stat()
    if (size > 0) {
      const last = Buffer.alloc(1)
      await handle.read(last, 0, 1, size - 1)
      separator = last[0] === 0x0a ? '' : '\n'
    }
  } finally {
    await handle.close()
  }
  const lines = entries.map((entry) => JSON.stringify(entry)).join('\n')
  await appendFile(path, `${separator}${lines}\n`, { flag: 'a' })
}
