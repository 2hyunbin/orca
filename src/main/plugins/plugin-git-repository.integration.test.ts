import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { checkoutPluginGitSource, runPluginGit } from './plugin-git-repository'
import { gitExecFileAsyncBuffer } from '../git/runner'
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-git-materialization-'))
  roots.push(root)
  const repository = join(root, 'source'),
    destination = join(root, 'download'),
    config = join(root, 'config'),
    hooks = join(root, 'hooks')
  const filtered = join(root, 'filter-executed'),
    hooked = join(root, 'hook-executed')
  await mkdir(hooks)
  await writeFile(config, '')
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  const configure = (key: string, value: string) =>
    runPluginGit(['config', '--file', config, key, value], root)
  await configure('protocol.file.allow', 'always')
  await configure(
    `url.${pathToFileURL(repository).href}.insteadOf`,
    'https://plugins.example.invalid/sample'
  )
  await configure('core.hooksPath', hooks)
  const nodeCommand = (code: string) =>
    `"${process.execPath.replaceAll('\\', '/')}" -e "eval(Buffer.from('${Buffer.from(code).toString('base64')}','base64').toString())"`
  await configure(
    'filter.phase-o-1.smudge',
    nodeCommand(
      `require('node:fs').writeFileSync(${JSON.stringify(filtered)},'executed');process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('changed by filter'));`
    )
  )
  await runPluginGit(['init', '--quiet', '--template=', repository], root)
  const git = (args: string[]) => runPluginGit(args, repository)
  await git(['config', 'user.name', 'Plugin fixture'])
  await git(['config', 'user.email', 'plugins@example.invalid'])
  const bytes = Buffer.from([0, 255, 13, 10, 65, 0, 128])
  await writeFile(join(repository, 'data.bin'), bytes)
  await writeFile(join(repository, '.gitattributes'), '*.bin filter=phase-o-1\n')
  await git(['add', '--all'])
  await git(['commit', '--quiet', '-m', 'Exact source bytes'])
  await git(['tag', 'v1'])
  await writeFile(
    join(hooks, 'post-checkout'),
    `#!/bin/sh\n${nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(hooked)},'executed')`)}\n`,
    { mode: 0o755 }
  )
  const checkout = (ref: string) =>
    checkoutPluginGitSource({
      url: 'https://plugins.example.invalid/sample',
      ref,
      destination,
      workingDirectory: root
    })
  return { root, repository, destination, bytes, filtered, hooked, git, checkout }
}
it.each(['tag', 'exact commit'])(
  'materializes exact binary blobs through %s without checkout hooks or smudge filters',
  async (mode) => {
    const f = await fixture()
    const commit = await f.git(['rev-parse', 'HEAD'])
    expect(await f.checkout(mode === 'tag' ? 'v1' : commit)).toBe(commit)
    expect(await readFile(join(f.destination, 'data.bin'))).toEqual(f.bytes)
    expect(await readFile(join(f.destination, '.gitattributes'), 'utf8')).toBe(
      '*.bin filter=phase-o-1\n'
    )
    await expect(access(f.filtered)).rejects.toThrow()
    await expect(access(f.hooked)).rejects.toThrow()
    expect(await readdir(f.destination)).not.toContain('.git')
  }
)
it('rejects symlink objects before writing any source files', async () => {
  const f = await fixture()
  const { stdout } = await gitExecFileAsyncBuffer(['hash-object', '-w', '--stdin'], {
    cwd: f.repository,
    stdin: '../outside.txt'
  })
  await f.git([
    'update-index',
    '--add',
    '--cacheinfo',
    `120000,${stdout.toString('utf8').trim()},escape`
  ])
  await f.git(['commit', '--quiet', '-m', 'Unsupported symbolic link'])
  await expect(f.checkout(await f.git(['rev-parse', 'HEAD']))).rejects.toThrow('symlinks')
  expect(await readdir(f.destination)).toEqual([])
  await expect(access(f.filtered)).rejects.toThrow()
  await expect(access(f.hooked)).rejects.toThrow()
})
