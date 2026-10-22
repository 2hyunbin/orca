import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import { withWslMoveSeededDrafts } from './wsl-move-seeded-drafts'

const UNC = 'repo-a::\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'
const HOST = 'repo-a::/home/dev/app'
const scope = {
  inScope: (owner: string) => owner.startsWith('repo-a::'),
  worktreeId: (id: string) => (id === UNC ? HOST : id),
  path: (value: string) => value.replace('\\\\wsl.localhost\\Ubuntu', '').replaceAll('\\', '/')
}

const file = (filePath: string, worktreeId: string, draft?: string): PersistedOpenFile => ({
  filePath,
  relativePath: 'README.md',
  worktreeId,
  language: 'markdown',
  ...(draft === undefined ? {} : { dirtyDraftContent: draft, lastKnownDiskSignature: 'sig-1' })
})

const seed = (): WorkspaceSessionState => ({
  ...getDefaultWorkspaceSession(),
  openFilesByWorktree: { [HOST]: [file('/home/dev/app/README.md', HOST)] }
})
const local = {
  openFilesByWorktree: {
    [UNC]: [file('\\\\wsl.localhost\\Ubuntu\\home\\dev\\app\\README.md', UNC, '# unsaved')]
  }
}

describe('withWslMoveSeededDrafts', () => {
  it("lays this desktop's draft and its disk baseline over the seeded file", () => {
    const next = withWslMoveSeededDrafts(seed(), local, scope, new Set([HOST]))

    expect(next?.openFilesByWorktree?.[HOST]).toEqual([
      { ...file('/home/dev/app/README.md', HOST, '# unsaved') }
    ])
  })

  it('leaves a workspace this run did not seed alone, so a file closed on the host stays closed', () => {
    expect(withWslMoveSeededDrafts(seed(), local, scope, new Set())).toBeNull()
  })

  it('never replaces a draft the seeded record already has', () => {
    const drafted = seed()
    drafted.openFilesByWorktree = {
      [HOST]: [file('/home/dev/app/README.md', HOST, '# newer')]
    }
    expect(withWslMoveSeededDrafts(drafted, local, scope, new Set([HOST]))).toBeNull()
  })
})
