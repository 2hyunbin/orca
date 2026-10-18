import { describe, expect, it, vi } from 'vitest'
import {
  selectEditorExternalWatchTargets,
  type EditorExternalWatchTargetState
} from './editor-external-watch-targets'
import {
  WARM_RECURSIVE_WATCH_WORKSPACE_COUNT,
  selectRecursiveWatchWorkspaceIds,
  toNarrowWatchFiles
} from './editor-external-watch-scope'

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))

type Repo = EditorExternalWatchTargetState['repos'][number]
type Worktree = EditorExternalWatchTargetState['worktreesByRepo'][string][number]
type OpenFile = EditorExternalWatchTargetState['openFiles'][number]

const repo = (id: string, connectionId: string | null = null): Repo =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixtures carry only the fields target selection reads.
  ({ id, path: `/${id}`, kind: 'git', connectionId }) as Repo
const worktree = (repoId: string, id: string): Worktree =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixtures carry only the fields target selection reads.
  ({ id, repoId, path: `/${repoId}/${id}` }) as Worktree
const file = (worktreeId: string, relativePath: string, extra: Partial<OpenFile> = {}): OpenFile =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixtures carry only the fields target selection reads.
  ({
    id: `${worktreeId}:${relativePath}`,
    worktreeId,
    filePath: `/${worktreeId}/${relativePath}`,
    relativePath,
    mode: 'edit',
    isDirty: false,
    ...extra
  }) as OpenFile

function makeState(args: {
  repos: Repo[]
  worktrees: Worktree[]
  openFiles: OpenFile[]
  activeWorktreeId: string | null
  lastVisitedAtByWorktreeId?: Record<string, number>
  folderWorkspaces?: EditorExternalWatchTargetState['folderWorkspaces']
}): EditorExternalWatchTargetState {
  const worktreesByRepo: EditorExternalWatchTargetState['worktreesByRepo'] = {}
  for (const wt of args.worktrees) {
    ;(worktreesByRepo[wt.repoId] ??= []).push(wt)
  }
  return {
    openFiles: args.openFiles,
    worktreesByRepo,
    repos: args.repos,
    activeWorktreeId: args.activeWorktreeId,
    lastVisitedAtByWorktreeId: args.lastVisitedAtByWorktreeId ?? {},
    rightSidebarOpen: false,
    rightSidebarTab: 'explorer',
    rightSidebarExplorerView: 'files',
    gitStatusHugeByWorktree: {},
    sshConnectionStates: new Map(),
    folderWorkspaces: args.folderWorkspaces ?? [],
    projectGroups: [],
    settings: null
  }
}

describe('selectRecursiveWatchWorkspaceIds', () => {
  it('keeps the active workspace plus the most recently visited ones and evicts older visits', () => {
    expect(WARM_RECURSIVE_WATCH_WORKSPACE_COUNT).toBe(3)
    const ids = selectRecursiveWatchWorkspaceIds(
      'active',
      {
        active: 100,
        a: 1,
        b: 5,
        c: 4,
        d: 3,
        'local|a': 9
      },
      () => true
    )
    expect([...ids].sort()).toEqual(['a', 'active', 'b', 'c'])
  })

  it('skips deleted workspaces so they cannot hold warm slots', () => {
    const ids = selectRecursiveWatchWorkspaceIds(
      'active',
      { gone: 9, a: 3, b: 2, c: 1 },
      (id) => id !== 'gone'
    )
    expect([...ids].sort()).toEqual(['a', 'active', 'b', 'c'])
  })

  it('has only the active workspace when nothing else was visited', () => {
    expect([...selectRecursiveWatchWorkspaceIds('active', undefined, () => true)]).toEqual([
      'active'
    ])
    expect([...selectRecursiveWatchWorkspaceIds(null, {}, () => true)]).toEqual([])
  })
})

describe('toNarrowWatchFiles', () => {
  it('dedupes and sorts worktree-relative files', () => {
    expect(toNarrowWatchFiles(['src/b.ts', 'a.ts', 'src/b.ts'])).toEqual(['a.ts', 'src/b.ts'])
  })

  it('refuses tabs that are not a file inside the workspace', () => {
    expect(toNarrowWatchFiles(['a.ts', '../outside.ts'])).toBeNull()
    expect(toNarrowWatchFiles(['a.ts', ''])).toBeNull()
    expect(toNarrowWatchFiles(['C:\\x.ts'])).toBeNull()
    expect(toNarrowWatchFiles([])).toBeNull()
  })
})

describe('selectEditorExternalWatchTargets narrowing', () => {
  it('watches the active workspace recursively and a background one through its open files only', () => {
    const r = repo('r')
    const state = makeState({
      repos: [r],
      worktrees: [worktree('r', 'active'), worktree('r', 'bg')],
      activeWorktreeId: 'active',
      openFiles: [
        file('active', 'src/a.ts'),
        file('bg', 'src/b.ts', { isDirty: true }),
        file('bg', 'src/c.ts'),
        file('bg', 'docs/readme.md', { mode: 'markdown-preview' })
      ]
    })

    const { targets } = selectEditorExternalWatchTargets(state)

    expect(targets).toEqual([
      {
        worktreeId: 'active',
        worktreePath: '/r/active',
        connectionId: undefined,
        runtimeEnvironmentId: null
      },
      {
        worktreeId: 'bg',
        worktreePath: '/r/bg',
        connectionId: undefined,
        runtimeEnvironmentId: null,
        narrowFiles: ['docs/readme.md', 'src/b.ts', 'src/c.ts']
      }
    ])
  })

  it('keeps warm workspaces recursive and narrows the one that fell out of the LRU', () => {
    const r = repo('r')
    const ids = ['w1', 'w2', 'w3', 'w4']
    const state = makeState({
      repos: [r],
      worktrees: [worktree('r', 'active'), ...ids.map((id) => worktree('r', id))],
      activeWorktreeId: 'active',
      lastVisitedAtByWorktreeId: { active: 10, w1: 9, w2: 8, w3: 7, w4: 1 },
      openFiles: ids.map((id) => file(id, 'x.ts'))
    })

    const { targets } = selectEditorExternalWatchTargets(state)

    expect(targets.map((target) => [target.worktreeId, target.narrowFiles ?? 'recursive'])).toEqual(
      [
        ['w1', 'recursive'],
        ['w2', 'recursive'],
        ['w3', 'recursive'],
        ['w4', ['x.ts']]
      ]
    )
  })

  it('collapses every local tab of one background workspace into a single narrow watch', () => {
    const r = repo('r')
    const state = makeState({
      repos: [r],
      worktrees: [worktree('r', 'bg')],
      activeWorktreeId: null,
      openFiles: [file('bg', 'a.ts'), file('bg', 'b.ts', { externalSshTargetId: undefined })]
    })

    const { targets } = selectEditorExternalWatchTargets(state)

    expect(targets).toHaveLength(1)
    expect(targets[0].narrowFiles).toEqual(['a.ts', 'b.ts'])
  })

  it('keeps WSL background workspaces recursive (the distro poller has no per-file mode)', () => {
    const r = repo('r')
    const wslWorktree = worktree('r', 'bg')
    wslWorktree.path = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
    const state = makeState({
      repos: [r],
      worktrees: [wslWorktree],
      activeWorktreeId: null,
      openFiles: [file('bg', 'a.ts')]
    })

    expect(selectEditorExternalWatchTargets(state).targets[0].narrowFiles).toBeUndefined()
  })

  it('keeps SSH background workspaces recursive (the relay has no narrow mode)', () => {
    const r = repo('r', 'ssh-1')
    const state = makeState({
      repos: [r],
      worktrees: [worktree('r', 'bg')],
      activeWorktreeId: null,
      openFiles: [file('bg', 'a.ts')]
    })

    expect(selectEditorExternalWatchTargets(state).targets).toEqual([
      { worktreeId: 'bg', worktreePath: '/r/bg', connectionId: 'ssh-1', runtimeEnvironmentId: null }
    ])
  })

  it('keeps runtime-owned background tabs recursive', () => {
    const r = repo('r')
    const state = makeState({
      repos: [r],
      worktrees: [worktree('r', 'bg')],
      activeWorktreeId: null,
      openFiles: [file('bg', 'a.ts', { runtimeEnvironmentId: 'env-1' })]
    })

    const [target] = selectEditorExternalWatchTargets(state).targets
    expect(target.runtimeEnvironmentId).toBe('env-1')
    expect(target.narrowFiles).toBeUndefined()
  })

  it('falls back to recursive when a background tab is not a file inside the workspace', () => {
    const r = repo('r')
    const state = makeState({
      repos: [r],
      worktrees: [worktree('r', 'bg')],
      activeWorktreeId: null,
      openFiles: [file('bg', 'a.ts'), file('bg', '../elsewhere/b.ts')]
    })

    expect(selectEditorExternalWatchTargets(state).targets[0].narrowFiles).toBeUndefined()
  })

  it('narrows a background folder workspace the same way as a worktree', () => {
    const workspaceKey = 'folder:f1'
    const state = makeState({
      repos: [],
      worktrees: [],
      activeWorktreeId: null,
      openFiles: [file(workspaceKey, 'notes/todo.md')],
      folderWorkspaces: [
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture carries only the fields target selection reads.
        {
          id: 'f1',
          projectGroupId: 'g',
          folderPath: '/folder',
          executionHostId: 'local'
        } as EditorExternalWatchTargetState['folderWorkspaces'][number]
      ]
    })

    expect(selectEditorExternalWatchTargets(state).targets).toEqual([
      {
        worktreeId: workspaceKey,
        worktreePath: '/folder',
        connectionId: undefined,
        runtimeEnvironmentId: null,
        narrowFiles: ['notes/todo.md']
      }
    ])
  })
})
