import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HistoryReader } from '../../../daemon/history-reader'
import { seedSessionFromStoredScrollback } from './stored-scrollback-session-seed'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('seedSessionFromStoredScrollback', () => {
  it('mints a session of the worktree that cold-restores the stored history', async () => {
    const historyDir = mkdtempSync(join(tmpdir(), 'orca-stored-scrollback-seed-'))
    roots.push(historyDir)
    const sessionId = seedSessionFromStoredScrollback({
      historyDir,
      worktreeId: 'repo::/home/me/project',
      scrollback: 'built ok\r\n$ ',
      cwd: '/home/me/project'
    })
    expect(sessionId.startsWith('repo::/home/me/project@@')).toBe(true)
    const detected = await new HistoryReader(historyDir).detectColdRestoreState(sessionId)
    expect(detected).toMatchObject({
      status: 'restored',
      restoreInfo: { scrollbackAnsi: 'built ok\r\n$ ', cwd: '/home/me/project' }
    })
  })
})
