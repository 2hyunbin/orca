import { BoundedMap } from '../../shared/bounded-map'
import { parseGitVersion, type GitVersion } from '../../shared/repo-object-maintenance-policy'
import { gitExecFileAsync } from './runner'

// Re-read periodically so an in-place Git upgrade is noticed without a restart.
const GIT_VERSION_TTL_MS = 60 * 60_000
const GIT_VERSION_TIMEOUT_MS = 10_000

const versions = new BoundedMap<
  string,
  { readAt: number; version: Promise<GitVersion | undefined> }
>({ maxEntries: 16 })

/** The Git version on the host that will run commands for `cwd`; undefined if unreadable. */
export function readHostGitVersion(
  cwd: string,
  wslDistro?: string
): Promise<GitVersion | undefined> {
  const key = wslDistro ? `wsl:${wslDistro}` : 'local'
  const cached = versions.get(key)
  if (cached && Date.now() - cached.readAt < GIT_VERSION_TTL_MS) {
    return cached.version
  }
  const version = gitExecFileAsync(['--version'], {
    cwd,
    ...(wslDistro ? { wslDistro } : {}),
    admissionTier: 'background',
    timeout: GIT_VERSION_TIMEOUT_MS
  }).then(
    ({ stdout }) => parseGitVersion(stdout),
    () => undefined
  )
  versions.set(key, { readAt: Date.now(), version })
  void version.then((resolved) => {
    if (!resolved && versions.get(key)?.version === version) {
      versions.delete(key)
    }
  })
  return version
}

export function clearHostGitVersionCache(): void {
  versions.clear()
}
