import { link, mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { truncateAiVaultListResult } from '../../shared/ai-vault-session-depth'
import { scanAiVaultSessions } from './session-scanner'
import { resetTranscriptHeadCwdCacheForTests } from './session-scope-cwd'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
  resetTranscriptHeadCwdCacheForTests()
})

async function writeRollout(sessionsDir: string, id: string, cwd: string, day: string) {
  const dir = join(sessionsDir, '2026', '10', day)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `rollout-2026-10-${day}T10-00-00-${id}.jsonl`)
  const timestamp = `2026-10-${day}T10:00:00.000Z`
  await writeFile(
    path,
    jsonLines([
      // Codex's first record carries its base instructions, past the first 8 KB read.
      { timestamp, type: 'session_meta', payload: { id, cwd, instructions: 'x'.repeat(20_000) } },
      {
        timestamp,
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'text', text: id }] }
      }
    ])
  )
  await utimes(path, new Date(timestamp), new Date(timestamp))
  return path
}

describe('scanAiVaultSessions — scope before the recency cap', () => {
  it('lists an older in-scope Codex session once across hardlinked homes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-scope-walk-'))
    tempRoots.push(root)
    const realHome = join(root, 'real-codex-home')
    const managedSessionsDir = join(root, 'codex-accounts', 'a1', 'home', 'sessions')
    const workspace = '/Users/ada/orca/workspaces/orca/taimen-2'

    const old = await writeRollout(managedSessionsDir, '01a14083-old', workspace, '11')
    await mkdir(join(realHome, 'sessions', '2026', '10', '11'), { recursive: true })
    await link(old, old.replace(managedSessionsDir, join(realHome, 'sessions')))
    for (const [index, day] of ['13', '14', '15'].entries()) {
      await writeRollout(managedSessionsDir, `02b-newer-${index}`, '/Users/ada/other', day)
    }

    const scan = (scopePaths?: string[]) =>
      scanAiVaultSessions({
        ...isolatedScanRoots(root),
        codexSessionsDir: join(realHome, 'sessions'),
        defaultCodexHomeDir: realHome,
        additionalCodexSessionsDirs: [managedSessionsDir],
        platform: 'darwin',
        limit: 2,
        scopePaths
      })

    expect((await scan()).sessions.map((session) => session.sessionId)).not.toContain(
      '01a14083-old'
    )
    const scoped = await scan([workspace])
    const inScope = scoped.sessions.filter((session) => session.cwd === workspace)
    expect(inScope.map((session) => session.sessionId)).toEqual(['01a14083-old'])
    // The host's cached list is cut by the same scope rule, so the recovered row survives it.
    expect(
      truncateAiVaultListResult(scoped, 2, [workspace]).sessions.map((s) => s.sessionId)
    ).toContain('01a14083-old')
  })
})
