import { gitExecFileAsync } from './runner'
import type { GitCapabilityCache } from '../../shared/git-capability-cache'
import { withLocalGitCapabilityCacheForExecution } from './git-capability-state'

const GIT_VERSION_TIMEOUT_MS = 10_000

let versions = new WeakMap<GitCapabilityCache, Promise<string>>()

/** `git --version` output on the host that runs commands for `cwd`; empty if unreadable. */
export function readHostGitVersion(cwd: string, wslDistro?: string): Promise<string> {
  return withLocalGitCapabilityCacheForExecution({ cwd, wslDistro }, (host) => {
    const cache = versions
    const cached = cache.get(host)
    if (cached) {
      return cached
    }
    const version = gitExecFileAsync(['--version'], {
      cwd,
      ...(wslDistro ? { wslDistro } : {}),
      admissionTier: 'background',
      timeout: GIT_VERSION_TIMEOUT_MS
    }).then(
      ({ stdout }) => stdout,
      () => {
        if (cache.get(host) === version) {
          cache.delete(host)
        }
        return ''
      }
    )
    cache.set(host, version)
    return version
  })
}

export function clearHostGitVersionCache(): void {
  versions = new WeakMap()
}
