import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import {
  checkoutPluginGitSource,
  PLUGIN_GIT_TRANSFER_TRACE_MAX_BYTES
} from './plugin-git-repository'

let root = ''
afterEach(async () => {
  vi.unstubAllEnvs()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['release', 'exact'])(
  'stops an oversized transferred pack with a small current tree: %s',
  async (ref) => {
    root = await mkdtemp(join(tmpdir(), 'orca-plugin-pack-budget-'))
    const source = join(root, 'source')
    const config = join(root, 'git-config')
    await mkdir(source)
    await writeFile(config, '')
    vi.stubEnv('GIT_CONFIG_GLOBAL', config)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    vi.stubEnv('GIT_CONFIG_COUNT', '0')
    const git = async (args: string[]) => {
      const result = await runProcess({ program: 'git', args, cwd: source, timeoutMs: 60000 })
      if (result.code !== 0) {
        throw new Error(result.stderr)
      }
      return result.stdout.trim()
    }
    await git(['init', '--quiet', '--template='])
    await git(['config', 'user.name', 'Plugin fixture'])
    await git(['config', 'user.email', 'plugins@example.invalid'])
    await writeFile(join(source, 'orca-plugin.json'), '{"fixture":true}\n')
    const large = await open(join(source, 'large-history.bin'), 'w')
    try {
      const chunk = randomBytes(1024 * 1024)
      for (
        let written = 0;
        written <= PLUGIN_GIT_TRANSFER_TRACE_MAX_BYTES;
        written += chunk.length
      ) {
        await large.write(chunk)
      }
    } finally {
      await large.close()
    }
    await git(['config', '--file', config, 'core.bigFileThreshold', '1m'])
    await git(['add', '.'])
    await git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'large history'])
    await git(['tag', 'unreviewed-pack-history'])
    await rm(join(source, 'large-history.bin'))
    await git(['add', '-u'])
    await git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'small current tree'])
    const commit = await git(['rev-parse', 'HEAD'])
    await git(['tag', 'release'])
    const url = 'https://plugins.example.invalid/pack-budget.git'
    await git(['config', '--file', config, `url.${pathToFileURL(source).href}.insteadOf`, url])
    // The owned server deliberately sends history the client did not request.
    await git([
      'config',
      '--file',
      config,
      'uploadpack.packObjectsHook',
      'git pack-objects --all --stdout #'
    ])
    const destination = join(root, 'download')
    let failure: unknown
    try {
      await checkoutPluginGitSource({
        url,
        ref: ref === 'exact' ? commit : ref,
        destination,
        workingDirectory: root
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) {
      throw new Error('The download unexpectedly succeeded')
    }
    expect(failure.message).toContain('exceeded its download budget')
    expect('stderr' in failure && failure.stderr).toBe('')
    expect('stdout' in failure && failure.stdout).toBe('')
    expect(await readdir(destination)).toEqual([])
    expect(await readFile(join(source, 'orca-plugin.json'), 'utf8')).toBe('{"fixture":true}\n')
  },
  60000
)

it('bounds an oversized HTTP discovery response before any object transfer', async () => {
  const { createServer } = await import('node:http')
  root = await mkdtemp(join(tmpdir(), 'orca-plugin-discovery-budget-'))
  const config = join(root, 'git-config')
  await writeFile(config, '')
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CONFIG_COUNT', '0')
  vi.stubEnv('GIT_TRACE_CURL_NO_DATA', '1')
  const bodySize = PLUGIN_GIT_TRANSFER_TRACE_MAX_BYTES * 2
  let sent = 0
  const paths: string[] = []
  const server = createServer((request, response) => {
    paths.push(request.url ?? '')
    response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': bodySize })
    const chunk = Buffer.alloc(64 * 1024, 65)
    const pump = () => {
      while (!response.destroyed && sent < bodySize) {
        sent += chunk.length
        if (!response.write(chunk)) {
          response.once('drain', pump)
          return
        }
      }
      if (sent >= bodySize) {
        response.end()
      }
    }
    pump()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('No fixture HTTP address')
    }
    const url = 'https://plugins.example.invalid/discovery.git'
    const configured = await runProcess({
      program: 'git',
      args: [
        'config',
        '--file',
        config,
        `url.http://127.0.0.1:${address.port}/repo.git.insteadOf`,
        url
      ],
      cwd: root
    })
    expect(configured.code).toBe(0)
    await expect(
      checkoutPluginGitSource({
        url,
        ref: '',
        destination: join(root, 'download'),
        workingDirectory: root
      })
    ).rejects.toThrow('exceeded its download budget')
    expect(sent).toBeLessThan(bodySize)
    expect(paths.every((path) => path.includes('/info/refs'))).toBe(true)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 60000)
