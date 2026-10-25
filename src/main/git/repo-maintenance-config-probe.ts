import {
  parseRepoMaintenanceConfig,
  readRepoMaintenanceConfig,
  REPO_MAINTENANCE_CONFIG_REGEXP,
  type RepoMaintenanceConfig
} from '../../shared/repo-maintenance-config'
import { isGitVersionAtLeast } from '../../shared/repo-object-maintenance-policy'
import { readHostGitVersion } from './git-version'
import { isUnsetGitConfigError } from './repo-pack-index-maintenance'
import { gitExecFileAsync } from './runner'

type ConfigProbeArgs = {
  repoPath: string
  /** Common dir as the executing Git spells it; registrations record that spelling. */
  commonDir: string | undefined
  wslDistro?: string
  signal: AbortSignal
}

/** One config read answers opt-out, external scheduling, partial clone and disabled tasks. */
export async function probeRepoMaintenanceConfig(
  args: ConfigProbeArgs
): Promise<RepoMaintenanceConfig> {
  const version = await readHostGitVersion(args.repoPath, args.wslDistro)
  const scoped = version !== undefined && isGitVersionAtLeast(version, 2, 26)
  let stdout = ''
  try {
    const result = await gitExecFileAsync(
      [
        'config',
        ...(scoped ? ['--show-scope'] : []),
        '--get-regexp',
        REPO_MAINTENANCE_CONFIG_REGEXP
      ],
      {
        cwd: args.repoPath,
        ...(args.wslDistro ? { wslDistro: args.wslDistro } : {}),
        admissionTier: 'background',
        signal: args.signal
      }
    )
    stdout = result.stdout
  } catch (error) {
    // `--get-regexp` exits 1 when nothing matches; anything else must not read as consent.
    if (!isUnsetGitConfigError(error)) {
      throw error
    }
  }
  const repoPaths = [args.repoPath]
  if (args.commonDir) {
    repoPaths.push(args.commonDir, args.commonDir.replace(/[\\/]\.git[\\/]?$/, ''))
  }
  return readRepoMaintenanceConfig(parseRepoMaintenanceConfig(stdout), repoPaths)
}
