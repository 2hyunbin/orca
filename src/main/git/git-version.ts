import { gitExecFileAsync } from './runner'

const GIT_VERSION_TIMEOUT_MS = 10_000

const versions = new Map<string, Promise<string>>()

/** `git --version` output on the host that runs commands for `cwd`; empty if unreadable. */
export function readHostGitVersion(cwd: string, wslDistro?: string): Promise<string> {
  const key = wslDistro ? `wsl:${wslDistro}` : 'local'
  const cached = versions.get(key)
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
      versions.delete(key)
      return ''
    }
  )
  versions.set(key, version)
  return version
}

export function clearHostGitVersionCache(): void {
  versions.clear()
}
