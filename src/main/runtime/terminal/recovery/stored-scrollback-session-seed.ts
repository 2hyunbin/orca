import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getHistorySessionDirName } from '../../../daemon/history-paths'
import { mintPtySessionId } from '../../../daemon/pty-session-id'
import type { SessionMeta } from '../../../daemon/terminal-history-metadata'

export type StoredScrollbackSessionSeed = {
  historyDir: string
  worktreeId: string
  scrollback: string
  cwd: string
}

/**
 * A terminal session id whose only history is a pane's stored scrollback, so the pane's next start
 * cold-restores it like any interrupted session. A moved or imported pane keeps its history only as
 * a stored snapshot, which no paired client's mirrored layout names; the session is what they attach to.
 */
export function seedSessionFromStoredScrollback(seed: StoredScrollbackSessionSeed): string {
  const sessionId = mintPtySessionId(seed.worktreeId)
  const dir = join(seed.historyDir, getHistorySessionDirName(sessionId))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const meta: SessionMeta = {
    cwd: seed.cwd,
    cols: 80,
    rows: 24,
    startedAt: new Date().toISOString(),
    // Why null: only a session that never ended cold-restores; this one never ran here at all.
    endedAt: null,
    exitCode: null
  }
  writeFileSync(join(dir, 'scrollback.bin'), seed.scrollback, { mode: 0o600 })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta), { mode: 0o600 })
  return sessionId
}
