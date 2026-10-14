import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wslMoveCutoverFixture as cutover } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import {
  removeWslMoveCutover,
  writeWslMoveCutover,
  wslMoveJournalDirectory
} from './wsl-move-cutover-journal'
import {
  WslMoveProjectFencedError,
  assertWslMoveWorkspaceWritable,
  isWslMoveFenceLoaded,
  loadWslMoveFence,
  resetWslMoveFenceForTests,
  withoutWslMovedProjects,
  wslMoveProjectRefForWorkspace
} from './wsl-move-scope-guard'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-guard-'))
  loadWslMoveFence(userDataPath)
})
afterEach(() => {
  resetWslMoveFenceForTests()
  rmSync(userDataPath, { recursive: true, force: true })
  vi.restoreAllMocks()
})
const asRepo = (row: { id: string }) => ({ repoId: row.id })

const repoPaths = new Map([
  ['repo-wsl', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'],
  ['repo-win', 'C:\\src\\app']
])
const store = {
  getRepo: (id: string) => {
    const path = repoPaths.get(id)
    return path === undefined ? undefined : { path }
  },
  getFolderWorkspace: () => undefined
}
const writable = (workspaceId: string) => () => assertWslMoveWorkspaceWritable(store, workspaceId)

describe('wslMoveProjectRefForWorkspace', () => {
  it.each([
    ['repo-1::\\\\wsl.localhost\\Ubuntu\\home\\dev\\app', { repoId: 'repo-1' }],
    ['worktree:repo-1::/home/dev/app', { repoId: 'repo-1' }],
    ['folder:notes', { folderWorkspaceId: 'notes' }],
    ['repo-1::/home/dev/app::workspace:7f3c', { repoId: 'repo-1' }],
    ['repo-1::/home/dev/a::b', { repoId: 'repo-1' }],
    ['bare-id', null]
  ])('%s', (key, expected) => {
    expect(wslMoveProjectRefForWorkspace(key)).toEqual(expected)
  })
})

describe('WSL move scope guard', () => {
  it('fences nothing before startup loads the journal', () => {
    resetWslMoveFenceForTests()
    writeWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
    expect(isWslMoveFenceLoaded()).toBe(false)
    expect(writable('repo-1::/x')).not.toThrow()
  })

  it('follows a write under another spelling of the same profile folder', () => {
    loadWslMoveFence(`${userDataPath}/./`)
    writeWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
    expect(writable('repo-1::/x')).toThrow(WslMoveProjectFencedError)
  })

  it('lifts the fence when the finished move is removed', () => {
    writeWslMoveCutover(userDataPath, cutover('move-1', 'retained'))
    expect(writable('repo-1::/x')).toThrow(WslMoveProjectFencedError)
    removeWslMoveCutover(userDataPath, 'move-1')
    expect(writable('repo-1::/x')).not.toThrow()
  })

  it('never matches a project on another host', () => {
    writeWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
    expect(writable('ssh:target-1|repo-1::/x')).not.toThrow()
  })

  it('follows journal writes without rereading on every check', () => {
    writeWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
    expect(writable('repo-1::/x')).toThrow(WslMoveProjectFencedError)
    rmSync(wslMoveJournalDirectory(userDataPath), { recursive: true, force: true })
    expect(writable('repo-1::/x')).toThrow(WslMoveProjectFencedError)
  })

  it('lets every project through when no move is recorded', () => {
    expect(writable('repo-1::/x')).not.toThrow()
    expect(withoutWslMovedProjects([{ id: 'repo-1' }], asRepo)).toHaveLength(1)
  })

  it('leaves a prepared move untouched', () => {
    writeWslMoveCutover(userDataPath, cutover('move-1', 'prepared'))
    expect(writable('repo-1::/x')).not.toThrow()
  })

  it('refuses work in a fenced project and keeps it listed', () => {
    writeWslMoveCutover(
      userDataPath,
      cutover('move-1', 'source-fenced', {}, { repoIds: ['repo-1'], folderWorkspaceIds: ['notes'] })
    )
    expect(writable('repo-1::/x')).toThrow(WslMoveProjectFencedError)
    expect(writable('folder:notes')).toThrow(WslMoveProjectFencedError)
    expect(writable('repo-2::/x')).not.toThrow()
    const rows = [{ id: 'repo-1' }, { id: 'repo-2' }]
    expect(withoutWslMovedProjects(rows, asRepo)).toEqual(rows)
  })

  it('hides and refuses a project the WSL host owns', () => {
    writeWslMoveCutover(
      userDataPath,
      cutover('move-1', 'destination-committed', {}, { folderWorkspaceIds: ['notes'] })
    )
    expect(writable('repo-1::/x')).toThrow(WslMoveProjectFencedError)
    expect(
      withoutWslMovedProjects([{ id: 'notes' }, { id: 'other' }], (f) => ({
        folderWorkspaceId: f.id
      }))
    ).toEqual([{ id: 'other' }])
  })

  it('keeps WSL projects read-only and every row listed when the journal is unreadable', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const directory = wslMoveJournalDirectory(userDataPath)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'move-1.json'), '{not json')
    loadWslMoveFence(userDataPath)
    expect(writable('repo-wsl::/x')).toThrow(WslMoveProjectFencedError)
    expect(writable('repo-win::/x')).not.toThrow()
    const rows = [{ id: 'repo-wsl' }]
    expect(withoutWslMovedProjects(rows, asRepo)).toEqual(rows)
  })
})
