import {
  isAllowedPluginGitUrl,
  PLUGIN_COMMIT_PATTERN
} from '../../shared/plugins/plugin-install-lockfile'
import { gitExecFileAsync } from '../git/runner'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializePluginGitTree } from './plugin-git-tree'
import { withLocalGitCapabilityCacheForExecution } from '../git/git-capability-state'
import { initializePluginSha256Repository } from './plugin-git-object-format'

const PLUGIN_GIT_TIMEOUT_MS = 120_000

/** Runs system Git with argv-only invocation so credential helpers and SSH
 * remotes work without exposing an executable remote-helper surface. */
export async function runPluginGit(
  args: string[],
  cwd: string,
  environment?: Record<string, string>
): Promise<string> {
  const { stdout } = await gitExecFileAsync(args, {
    cwd,
    timeout: PLUGIN_GIT_TIMEOUT_MS,
    ...(environment ? { env: { ...process.env, ...environment } } : {})
  })
  return stdout.trim()
}

/** Materializes exact blobs without invoking checkout filters or hooks. */
export async function checkoutPluginGitSource(input: {
  url: string
  ref: string
  destination: string
  workingDirectory: string
}): Promise<string> {
  if (!isAllowedPluginGitUrl(input.url)) {
    throw new Error('plugin Git URL must use HTTPS or SSH')
  }
  const ref = input.ref.trim()
  await mkdir(input.destination, { recursive: true })
  if ((await readdir(input.destination)).length > 0) {
    throw new Error('plugin Git destination must be empty')
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'orca-plugin-git-'))
  const repository = join(temporaryRoot, 'repository')
  const hooks = join(temporaryRoot, 'no-hooks')
  const config = [
    '-c',
    `core.hooksPath=${hooks}`,
    '-c',
    'submodule.recurse=false',
    '-c',
    'fetch.recurseSubmodules=false',
    '-c',
    'gc.auto=0',
    '-c',
    'maintenance.auto=false'
  ]
  const run = (args: string[], cwd: string) =>
    runPluginGit([...config, ...args], cwd, { GIT_DEFAULT_HASH: 'sha1' })
  try {
    await mkdir(hooks)
    const exactCommit = PLUGIN_COMMIT_PATTERN.test(ref)
    if (exactCommit) {
      await (ref.length === 64
        ? withLocalGitCapabilityCacheForExecution({ cwd: input.workingDirectory }, (capabilities) =>
            initializePluginSha256Repository({
              repository,
              workingDirectory: input.workingDirectory,
              capabilities,
              run
            })
          )
        : run(['init', '--quiet', '--template=', repository], input.workingDirectory))
      await run(['remote', 'add', 'origin', input.url], repository)
      await run(['fetch', '--quiet', '--depth', '1', 'origin', ref], repository)
    } else {
      const args = [
        'clone',
        '--quiet',
        '--no-checkout',
        '--no-recurse-submodules',
        '--template=',
        '--depth',
        '1'
      ]
      if (ref.length > 0) {
        args.push('--branch', ref)
      }
      args.push('--', input.url, repository)
      await run(args, input.workingDirectory)
    }
    const resolvedCommit = await run(
      ['rev-parse', '--verify', `${exactCommit ? 'FETCH_HEAD' : 'HEAD'}^{commit}`],
      repository
    )
    if (!PLUGIN_COMMIT_PATTERN.test(resolvedCommit)) {
      throw new Error('Git resolved an invalid commit identity')
    }
    await materializePluginGitTree({
      repository,
      commit: resolvedCommit,
      destination: input.destination
    })
    return resolvedCommit
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}
