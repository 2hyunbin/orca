import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wslMoveCutoverFixture as cutover } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { wslMoveJournalDirectory, writeWslMoveCutover } from './wsl-move-cutover-journal'
import { loadWslMoveFence, resetWslMoveFenceForTests } from './wsl-move-scope-guard'
import {
  isWslMoveFolderWorkspaceBlocked,
  isWslMoveRepoBlocked,
  isWslMoveWorktreeBlocked
} from './wsl-move-background-backoff'

const onSsh = { connectionId: 'target-1', executionHostId: 'ssh:target-1' }
const WSL_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-backoff-'))
  loadWslMoveFence(userDataPath)
})
afterEach(() => {
  resetWslMoveFenceForTests()
  rmSync(userDataPath, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('WSL move background backoff', () => {
  beforeEach(() => {
    writeWslMoveCutover(
      userDataPath,
      cutover('move-1', 'source-fenced', {}, { repoIds: ['repo-1'], folderWorkspaceIds: ['notes'] })
    )
  })

  it('backs off only the local row of a moving repo', () => {
    expect(isWslMoveRepoBlocked({ id: 'repo-1', path: '/a' })).toBe(true)
    expect(isWslMoveRepoBlocked({ id: 'repo-1', path: '/a', ...onSsh })).toBe(false)
    expect(isWslMoveRepoBlocked({ id: 'repo-2', path: '/a' })).toBe(false)
  })

  it('backs off only the local row of a moving folder workspace', () => {
    expect(isWslMoveFolderWorkspaceBlocked({ id: 'notes', folderPath: '/n' })).toBe(true)
    expect(isWslMoveFolderWorkspaceBlocked({ id: 'notes', folderPath: '/n', ...onSsh })).toBe(false)
    expect(isWslMoveFolderWorkspaceBlocked({ id: 'other', folderPath: '/n' })).toBe(false)
  })

  it('backs off a worktree by its id and host', () => {
    expect(isWslMoveWorktreeBlocked('repo-1::/a/wt', 'local')).toBe(true)
    expect(isWslMoveWorktreeBlocked('repo-1::/a/wt', undefined)).toBe(true)
    expect(isWslMoveWorktreeBlocked('repo-1::/a/wt', 'ssh:target-1')).toBe(false)
    expect(isWslMoveWorktreeBlocked('repo-2::/a/wt', 'local')).toBe(false)
  })
})

it('backs off only WSL paths when the journal is unreadable', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const directory = wslMoveJournalDirectory(userDataPath)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'move-1.json'), '{not json')
  loadWslMoveFence(userDataPath)

  expect(isWslMoveRepoBlocked({ id: 'repo-1', path: WSL_PATH })).toBe(true)
  expect(isWslMoveRepoBlocked({ id: 'repo-1', path: 'C:\\src\\app' })).toBe(false)
  expect(isWslMoveFolderWorkspaceBlocked({ id: 'notes', folderPath: WSL_PATH })).toBe(true)
  expect(isWslMoveWorktreeBlocked(`repo-1::${WSL_PATH}\\wt`, 'local')).toBe(true)
  expect(isWslMoveWorktreeBlocked('repo-1::C:\\src\\app\\wt', 'local')).toBe(false)
})
