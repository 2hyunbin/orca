import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { OrcadMigrationCatalogPayload } from '../../../shared/orcad-migration-manifest'
import type { Repo } from '../../../shared/repo-types'
import { rewriteOrcadMigrationPayloadPaths } from '../../ssh/orcad-migration-path-rewrite'
import { createUncToLinuxPathRewriter } from './wsl-move-path-rewriter'
import { collectWslMoveScope } from './wsl-move-scope'

const unc = (linux: string, distro = 'Ubuntu', host = 'wsl.localhost') =>
  `\\\\${host}\\${distro}${linux.replaceAll('/', '\\')}`

const repo = (id: string, path: string, extra: Partial<Repo> = {}): Repo => ({
  id,
  path,
  displayName: id,
  badgeColor: '#000',
  addedAt: 0,
  ...extra
})

const folder = (id: string, folderPath: string, extra: Partial<FolderWorkspace> = {}) => ({
  id,
  projectGroupId: 'group',
  name: id,
  folderPath,
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  createdAt: 0,
  updatedAt: 0,
  ...extra
})

describe('collectWslMoveScope', () => {
  it('takes local projects whose every path is in the distro, under either UNC spelling', () => {
    const scope = collectWslMoveScope(
      {
        repos: [
          repo('a', unc('/home/dev/a')),
          repo('b', unc('/home/dev/b', 'ubuntu', 'wsl$'), {
            worktreeBasePath: unc('/home/dev/worktrees')
          }),
          repo('relative-base', unc('/home/dev/c'), { worktreeBasePath: '../worktrees' })
        ],
        folderWorkspaces: [folder('notes', unc('/srv/notes'))]
      },
      'Ubuntu'
    )
    expect(scope).toEqual({
      repoIds: ['a', 'b', 'relative-base'],
      folderWorkspaceIds: ['notes'],
      refused: []
    })
  })

  it('ignores Windows projects and other distros without a refusal', () => {
    const scope = collectWslMoveScope(
      {
        repos: [repo('win', 'C:\\src\\win'), repo('deb', unc('/home/dev/x', 'Debian'))],
        folderWorkspaces: []
      },
      'Ubuntu'
    )
    expect(scope).toEqual({ repoIds: [], folderWorkspaceIds: [], refused: [] })
  })

  it('refuses, with the reason, what touches the distro but breaks the rule', () => {
    const scope = collectWslMoveScope(
      {
        repos: [
          repo('drive', unc('/mnt/c/src/app')),
          repo('base-on-windows', unc('/home/dev/a'), { worktreeBasePath: 'D:\\worktrees' }),
          repo('ssh', unc('/home/dev/s'), { executionHostId: 'ssh:target' })
        ],
        folderWorkspaces: [folder('remote', unc('/srv/r'), { connectionId: 'ssh-1' })]
      },
      'Ubuntu'
    )
    expect(scope.repoIds).toEqual([])
    expect(scope.refused).toEqual([
      { kind: 'repo', id: 'drive', reason: 'windows-drive' },
      { kind: 'repo', id: 'base-on-windows', reason: 'mixed-locations' },
      { kind: 'repo', id: 'ssh', reason: 'not-local' },
      { kind: 'folder-workspace', id: 'remote', reason: 'not-local' }
    ])
  })
})

describe('createUncToLinuxPathRewriter', () => {
  const rewriter = createUncToLinuxPathRewriter('Ubuntu')

  it.each([
    [unc('/home/dev/app'), 'absolute', '/home/dev/app'],
    ['//wsl$/UBUNTU/home/dev/app', 'absolute', '/home/dev/app'],
    [unc('/home/dev/app', 'Debian'), 'absolute', unc('/home/dev/app', 'Debian')],
    ['/home/dev/app', 'absolute', '/home/dev/app'],
    ['../worktrees', 'maybe-absolute', '../worktrees'],
    ['src\\main\\a.ts', 'relative', 'src/main/a.ts'],
    ['file://wsl.localhost/Ubuntu/home/a.html', 'url', 'file:///home/a.html'],
    ['file://wsl.localhost/Debian/home/a.html', 'url', 'file://wsl.localhost/Debian/home/a.html'],
    ['https://example.com/', 'url', 'https://example.com/']
  ] as const)('%s (%s) → %s', (value, form, expected) => {
    expect(rewriter.path(value, form)).toBe(expected)
  })

  it('rewrites a whole catalog, including worktree ids and owner keys', () => {
    const repoPath = unc('/home/dev/app')
    const worktreeId = `repo-a::${repoPath}`
    const payload: OrcadMigrationCatalogPayload = {
      repositories: [repo('repo-a', repoPath)],
      projectGroups: [],
      folderWorkspaces: [],
      dormantState: {
        version: 1,
        worktreeMeta: [
          {
            sourceKey: worktreeId,
            worktreeId,
            meta: {
              displayName: 'app',
              comment: '',
              linkedIssue: null,
              linkedPR: null,
              linkedLinearIssue: null,
              isArchived: false,
              isUnread: false,
              isPinned: false,
              sortOrder: 0,
              lastActivityAt: 0
            }
          }
        ],
        worktreeLineage: [],
        workspaceLineage: [],
        sparsePresets: [],
        retiredWorktreeNames: [],
        retiredWorktreeNamespaces: []
      }
    }
    const rewritten = rewriteOrcadMigrationPayloadPaths(payload, rewriter)
    expect(rewritten.repositories[0].path).toBe('/home/dev/app')
    // The source key stays in its source form: subtraction matches source rows by it.
    expect(rewritten.dormantState?.worktreeMeta[0]).toMatchObject({
      sourceKey: worktreeId,
      worktreeId: 'repo-a::/home/dev/app'
    })
  })
})
