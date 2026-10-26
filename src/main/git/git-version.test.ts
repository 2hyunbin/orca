import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const git = vi.hoisted(() => vi.fn())
vi.mock('./runner', () => ({ gitExecFileAsync: git }))

import { clearHostGitVersionCache, readHostGitVersion } from './git-version'
import { clearGitCapabilityStateForTests } from './git-capability-state'
import {
  resetWslLinkedWorktreeGitRoutingForTests,
  seedWslLinkedWorktreeGitRoutingForTests
} from './wsl-linked-worktree-git-routing'

const linked = String.raw`C:\repo\linked`
const ubuntu = String.raw`\\wsl.localhost\Ubuntu\home\dev\repo`
const nativeVersion = 'git version 2.55.0.windows.1'
const ubuntuVersion = 'git version 2.52.0'

beforeEach(() => {
  git.mockReset()
  clearHostGitVersionCache()
  clearGitCapabilityStateForTests()
  resetWslLinkedWorktreeGitRoutingForTests()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
})

afterEach(() => vi.restoreAllMocks())

describe('Git version execution-host cache', () => {
  it.each([false, true])(
    'isolates Windows-authored linked worktrees from their WSL distro (WSL first: %s)',
    async (wslFirst) => {
      seedWslLinkedWorktreeGitRoutingForTests(linked)
      git.mockImplementation(async (_args, options: { cwd: string }) => ({
        stdout: options.cwd === linked ? nativeVersion : ubuntuVersion
      }))
      const targets = wslFirst ? [ubuntu, linked] : [linked, ubuntu]
      for (const cwd of targets) {
        expect(await readHostGitVersion(cwd, 'Ubuntu')).toBe(
          cwd === linked ? nativeVersion : ubuntuVersion
        )
      }
      expect(await readHostGitVersion('C:/another-native-repo')).toBe(nativeVersion)
      expect(await readHostGitVersion(ubuntu, 'Ubuntu')).toBe(ubuntuVersion)
      expect(git).toHaveBeenCalledTimes(2)
    }
  )

  it('infers the WSL host from UNC paths and shares its explicit-distro lookup', async () => {
    git.mockResolvedValueOnce({ stdout: nativeVersion })
    git.mockResolvedValueOnce({ stdout: ubuntuVersion })
    expect(await readHostGitVersion('C:/repo')).toBe(nativeVersion)
    expect(await readHostGitVersion(ubuntu)).toBe(ubuntuVersion)
    expect(await readHostGitVersion(ubuntu, 'Ubuntu')).toBe(ubuntuVersion)
    expect(git).toHaveBeenCalledTimes(2)
  })

  it('deduplicates concurrent version probes on the same execution host', async () => {
    git.mockResolvedValue({ stdout: ubuntuVersion })
    expect(
      await Promise.all([readHostGitVersion(ubuntu), readHostGitVersion(ubuntu, 'Ubuntu')])
    ).toEqual([ubuntuVersion, ubuntuVersion])
    expect(git).toHaveBeenCalledOnce()
  })

  it('does not evict a replacement lookup when a cleared in-flight probe fails', async () => {
    let fail: ((error: Error) => void) | undefined
    git.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)))
    const stale = readHostGitVersion('C:/repo')
    clearHostGitVersionCache()
    git.mockResolvedValueOnce({ stdout: nativeVersion })
    expect(await readHostGitVersion('C:/repo')).toBe(nativeVersion)
    fail?.(new Error('old probe failed'))
    expect(await stale).toBe('')
    expect(await readHostGitVersion('C:/repo')).toBe(nativeVersion)
    expect(git).toHaveBeenCalledTimes(2)
  })
})
