import { expect, it } from 'vitest'
import { parsePluginGitTree, readPluginGitBatchBlobs } from './plugins/plugin-git-tree-format'
import { isUnsupportedGitSha256InitError } from './git-object-format-capability'

export function registerGitPluginTreeBinaryCompatibilityCases(
  runGit: (
    args: string[],
    env?: NodeJS.ProcessEnv,
    stdin?: string
  ) => Promise<{ stdout: string; stderr: string }>,
  supports: (major: number, minor: number) => boolean,
  removeDirectories: (directories: string[]) => Promise<void>
): void {
  it('fetches exact SHA-256 commits or recognizes the baseline unsupported option', async () => {
    const source = 'compat-plugin-sha256-source'
    const destination = 'compat-plugin-sha256-download'
    try {
      const initialize = (directory: string) =>
        runGit(
          [
            '-c',
            'gc.auto=0',
            '-c',
            'maintenance.auto=false',
            'init',
            '--quiet',
            '--template=',
            '--object-format=sha256',
            directory
          ],
          { GIT_DEFAULT_HASH: 'sha1' }
        )
      if (!supports(2, 29)) {
        try {
          await initialize(source)
          throw new Error('baseline unexpectedly supports SHA-256')
        } catch (error) {
          expect(isUnsupportedGitSha256InitError(error)).toBe(true)
        }
        return
      }
      await initialize(source)
      await runGit(['-C', source, 'config', 'user.name', 'Plugin compatibility'])
      await runGit(['-C', source, 'config', 'user.email', 'plugins@example.invalid'])
      const blob = (
        await runGit(['-C', source, 'hash-object', '-w', '--stdin'], undefined, 'compatibility\n')
      ).stdout.trim()
      const tree = (
        await runGit(['-C', source, 'mktree'], undefined, `100644 blob ${blob}\ttracked.txt\n`)
      ).stdout.trim()
      const commit = (
        await runGit(['-C', source, 'commit-tree', tree], undefined, 'SHA-256 fixture\n')
      ).stdout.trim()
      expect(commit).toMatch(/^[0-9a-f]{64}$/)
      await runGit(['-C', source, 'update-ref', 'refs/heads/release', commit])
      await initialize(destination)
      const inDownload = (args: string[], stdin?: string) =>
        runGit(['-C', destination, ...args], undefined, stdin)
      await inDownload([
        '-c',
        'gc.auto=0',
        '-c',
        'maintenance.auto=false',
        'fetch',
        '--quiet',
        '--depth',
        '1',
        `../${source}`,
        commit
      ])
      expect(
        (await inDownload(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).stdout.trim()
      ).toBe(commit)
      expect((await inDownload(['ls-files'])).stdout).toBe('')
      const entries = parsePluginGitTree(
        Buffer.from(
          (await inDownload(['ls-tree', '-r', '-t', '-l', '-z', '--full-tree', commit])).stdout
        )
      )
      const tracked = entries.find((entry) => entry.path === 'tracked.txt')
      if (tracked?.kind !== 'blob') {
        throw new Error('SHA-256 fixture is missing its committed blob')
      }
      const batch = await inDownload(['cat-file', '--batch'], `${tracked.object}\n`)
      expect(
        readPluginGitBatchBlobs(Buffer.from(batch.stdout), [tracked])
          .get(tracked.object)
          ?.toString('utf8')
      ).toBe('compatibility\n')
    } finally {
      await removeDirectories([source, destination])
    }
  })

  it('downloads without checkout and reads exact bounded tree/blob metadata on baseline Git', async () => {
    const destination = 'compat-plugin-raw-download'
    const config = [
      '-c',
      'gc.auto=0',
      '-c',
      'maintenance.auto=false',
      '-c',
      'submodule.recurse=false'
    ]
    await runGit([
      ...config,
      'clone',
      '--quiet',
      '--no-checkout',
      '--no-recurse-submodules',
      '--template=',
      '--no-local',
      '--',
      '.',
      destination
    ])
    const inDownload = (args: string[], stdin?: string) =>
      runGit(['-C', destination, ...args], undefined, stdin)
    expect((await inDownload(['ls-files'])).stdout).toBe('')
    const commit = (await inDownload(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim()
    const metadata = await inDownload(['ls-tree', '-r', '-t', '-l', '-z', '--full-tree', commit])
    const entries = parsePluginGitTree(Buffer.from(metadata.stdout))
    const tracked = entries.find((entry) => entry.path === 'tracked.txt')
    expect(tracked?.kind).toBe('blob')
    if (tracked?.kind !== 'blob') {
      throw new Error('compatibility fixture is missing its committed blob')
    }
    const batch = await inDownload(['cat-file', '--batch'], `${tracked.object}\n`)
    expect(
      readPluginGitBatchBlobs(Buffer.from(batch.stdout), [tracked])
        .get(tracked.object)
        ?.toString('utf8')
    ).toBe('compatibility\n')
  })
}
