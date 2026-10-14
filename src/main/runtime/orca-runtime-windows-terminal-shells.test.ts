import { afterEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

const platform = process.platform

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

function runtimeWithRepos(
  repos: { id: string; connectionId: string | null }[]
): OrcaRuntimeService {
  const store = {
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getRepos: () => repos,
    getProjects: () => [],
    getSettings: () => ({})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: withWindowsTerminalShells reads only getRepo, getProjects and getSettings from the store.
  return new OrcaRuntimeService(store as never)
}

const worktree = (repoId: string, path: string) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stamp reads only id, repoId and path from a worktree row.
  ({ id: `${repoId}::${path}`, repoId, path }) as never

afterEach(() => setPlatform(platform))

describe('withWindowsTerminalShells', () => {
  it('stamps each workspace on a Windows host with the shells terminal.create would honour', () => {
    setPlatform('win32')
    const runtime = runtimeWithRepos([
      { id: 'local', connectionId: null },
      { id: 'ssh', connectionId: 'ssh-1' }
    ])

    const { worktrees } = runtime.withWindowsTerminalShells({
      worktrees: [worktree('local', 'C:\\app'), worktree('ssh', '/home/u/app')]
    })

    expect(worktrees[0]).toHaveProperty(
      'windowsTerminalShells',
      expect.arrayContaining(['powershell.exe', 'cmd.exe', 'git-bash'])
    )
    expect(worktrees[1]).toHaveProperty('windowsTerminalShells', [])
  })

  it('sends no list from a host that is not Windows', () => {
    setPlatform('darwin')
    const runtime = runtimeWithRepos([{ id: 'local', connectionId: null }])

    const { worktrees } = runtime.withWindowsTerminalShells({
      worktrees: [worktree('local', '/Users/u/app')]
    })

    expect(worktrees[0]).not.toHaveProperty('windowsTerminalShells')
  })
})
