import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GitCapabilityCache } from '../../shared/git-capability-cache'
import {
  clearGitCapabilityStateForTests,
  getLocalGitCapabilityCache
} from '../git/git-capability-state'
import { initializePluginSha256Repository } from './plugin-git-object-format'

const unsupported = new Error("error: unknown option 'object-format=sha256'")
const initialize = (
  capabilities: GitCapabilityCache,
  run: (args: string[], cwd: string) => Promise<string>,
  repository = 'staged-package'
) =>
  initializePluginSha256Repository({
    repository,
    workingDirectory: 'install-root',
    capabilities,
    run
  })

describe('plugin SHA-256 initialization', () => {
  beforeEach(clearGitCapabilityStateForTests)

  it('initializes every repository after a successful shared probe', async () => {
    const cache = new GitCapabilityCache()
    const run = vi.fn(async () => '')
    await initialize(cache, run, 'first')
    await initialize(cache, run, 'second')
    expect(run.mock.calls).toEqual([
      [['init', '--quiet', '--template=', '--object-format=sha256', 'first'], 'install-root'],
      [['init', '--quiet', '--template=', '--object-format=sha256', 'second'], 'install-root']
    ])
  })

  it('explains unsupported Git once and skips later known-invalid commands', async () => {
    const cache = new GitCapabilityCache()
    const run = vi.fn(async () => {
      throw unsupported
    })
    await expect(initialize(cache, run)).rejects.toThrow('Update Git and retry')
    await expect(initialize(cache, run)).rejects.toThrow('Update Git and retry')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent unsupported probes without hanging either install', async () => {
    const cache = new GitCapabilityCache()
    let rejectProbe!: (error: Error) => void
    const run = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectProbe = reject
        })
    )
    const first = initialize(cache, run, 'first')
    const second = initialize(cache, run, 'second')
    const results = Promise.allSettled([first, second])
    rejectProbe(unsupported)
    expect(await results).toEqual([
      {
        status: 'rejected',
        reason: expect.objectContaining({
          message: expect.stringContaining('Update Git and retry')
        })
      },
      {
        status: 'rejected',
        reason: expect.objectContaining({
          message: expect.stringContaining('Update Git and retry')
        })
      }
    ])
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('allows each install to proceed after a concurrent successful probe', async () => {
    const cache = new GitCapabilityCache()
    let resolveProbe!: (value: string) => void
    const run = vi
      .fn(async () => '')
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveProbe = resolve
          })
      )
    const first = initialize(cache, run, 'first')
    const second = initialize(cache, run, 'second')
    expect(run).toHaveBeenCalledTimes(1)
    resolveProbe('')
    await Promise.all([first, second])
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('preserves transient failures and permits the next real attempt', async () => {
    const cache = new GitCapabilityCache()
    const failure = new Error('No space left on device')
    const run = vi.fn(async () => '').mockRejectedValueOnce(failure)
    await expect(initialize(cache, run)).rejects.toBe(failure)
    await expect(initialize(cache, run)).resolves.toBeUndefined()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not share a native failure with either WSL execution host', async () => {
    const run = vi.fn(async () => '').mockRejectedValueOnce(unsupported)
    await expect(initialize(getLocalGitCapabilityCache(), run)).rejects.toThrow('Update Git')
    await initialize(getLocalGitCapabilityCache({ wslDistro: 'Ubuntu' }), run)
    await initialize(getLocalGitCapabilityCache({ wslDistro: 'Debian' }), run)
    await expect(initialize(getLocalGitCapabilityCache(), run)).rejects.toThrow('Update Git')
    expect(run).toHaveBeenCalledTimes(3)
  })
})
