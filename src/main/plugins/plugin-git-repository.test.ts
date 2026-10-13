import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { checkoutPluginGitSource } from './plugin-git-repository'
import { hashPluginTree } from './plugin-content-hash'

let root = ''
let source = ''
let config = ''
const url = 'https://plugins.example.invalid/package.git'

async function git(args: string[], cwd = source): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd, timeoutMs: 30_000 })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error(result.stderr || 'fixture Git failed')
  }
  return result.stdout.trim()
}

async function commit(): Promise<string> {
  await git(['add', '.'])
  await git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'isolated fixture'])
  return git(['rev-parse', 'HEAD'])
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-plugin-git-proof-'))
  source = join(root, 'source')
  config = join(root, 'git-config')
  await mkdir(source)
  await writeFile(config, '')
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CONFIG_COUNT', '0')
  await git(['init', '--quiet', '--template='])
  await git(['config', 'user.name', 'Plugin fixture'])
  await git(['config', 'user.email', 'plugins@example.invalid'])
  await git(['config', `url.${pathToFileURL(source).href}.insteadOf`, url])
  await git(['config', '--file', config, `url.${pathToFileURL(source).href}.insteadOf`, url])
  await writeFile(join(source, 'orca-plugin.json'), '{"fixture":true}\n')
  await mkdir(join(source, 'nested'))
  await writeFile(join(source, 'nested', 'binary.bin'), Buffer.from([0, 10, 255, 13, 10]))
  await commit()
  await git(['tag', 'release'])
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe('script-free exact Git materialization', () => {
  it.each(['release', 'exact'])('materializes SHA-256 repository bytes: %s', async (ref) => {
    await rm(join(source, '.git'), { recursive: true })
    await git(['init', '--quiet', '--template=', '--object-format=sha256'])
    await git(['config', 'user.name', 'Plugin fixture'])
    await git(['config', 'user.email', 'plugins@example.invalid'])
    const expectedCommit = await commit()
    expect(expectedCommit).toMatch(/^[0-9a-f]{64}$/)
    await git(['tag', 'release'])
    const expected = await hashPluginTree(source)
    expect(expected.ok).toBe(true)
    const destination = join(root, `sha256-${ref}`)
    await expect(
      checkoutPluginGitSource({
        url,
        ref: ref === 'exact' ? expectedCommit : ref,
        destination,
        workingDirectory: root
      })
    ).resolves.toBe(expectedCommit)
    expect(await hashPluginTree(destination)).toEqual(expected)
    await expect(access(join(destination, '.git'))).rejects.toThrow()
  })

  it.each(['release', '', 'exact'])(
    'preserves commit bytes with configured CRLF and filters: %s',
    async (ref) => {
      await writeFile(
        join(source, '.gitattributes'),
        '*.json text eol=crlf filter=approval-proof\n'
      )
      const expectedCommit = await commit()
      await git(['tag', '--force', 'release'])
      await git(['config', '--file', config, 'core.autocrlf', 'true'])
      await git([
        'config',
        '--file',
        config,
        'filter.approval-proof.smudge',
        'echo UNREVIEWED_FILTER'
      ])
      await git(['config', '--file', config, 'filter.approval-proof.required', 'true'])
      const expected = await hashPluginTree(source)
      expect(expected.ok).toBe(true)
      const destination = join(root, `download-${ref || 'default'}`)
      vi.stubEnv('GIT_DEFAULT_HASH', 'sha256')
      const resolved = await checkoutPluginGitSource({
        url,
        ref: ref === 'exact' ? expectedCommit : ref,
        destination,
        workingDirectory: root
      })
      expect(resolved).toBe(expectedCommit)
      expect(await hashPluginTree(destination)).toEqual(expected)
      expect(await readFile(join(destination, 'orca-plugin.json'), 'utf8')).toBe(
        '{"fixture":true}\n'
      )
      expect(await readFile(join(destination, 'nested', 'binary.bin'))).toEqual(
        Buffer.from([0, 10, 255, 13, 10])
      )
      await expect(access(join(destination, '.git'))).rejects.toThrow()
      const unsafe = join(root, 'ordinary-checkout')
      await git(['clone', '--quiet', '--', url, unsafe], root)
      expect(await readFile(join(unsafe, 'orca-plugin.json'), 'utf8')).toContain(
        'UNREVIEWED_FILTER'
      )
      expect(await hashPluginTree(unsafe)).not.toEqual(expected)
    }
  )

  it('does not run global or copied-template post-checkout hooks', async () => {
    const hooks = join(root, 'hooks')
    const templates = join(root, 'templates')
    await mkdir(hooks)
    await mkdir(join(templates, 'hooks'), { recursive: true })
    await writeFile(join(hooks, 'post-checkout'), '#!/bin/sh\nexit 93\n', { mode: 0o755 })
    await writeFile(join(templates, 'hooks', 'post-checkout'), '#!/bin/sh\nexit 94\n', {
      mode: 0o755
    })
    await git(['config', '--file', config, 'core.hooksPath', hooks])
    await git(['config', '--file', config, 'init.templateDir', templates])
    await expect(
      git(['clone', '--quiet', '--', url, join(root, 'unsafe-global')], root)
    ).rejects.toThrow()
    await expect(
      checkoutPluginGitSource({
        url,
        ref: 'release',
        destination: join(root, 'safe-global'),
        workingDirectory: root
      })
    ).resolves.toMatch(/^[0-9a-f]{40}$/)
    await git(['config', '--file', config, '--unset', 'core.hooksPath'])
    await expect(
      git(['clone', '--quiet', '--', url, join(root, 'unsafe-template')], root)
    ).rejects.toThrow()
    await expect(
      checkoutPluginGitSource({
        url,
        ref: 'release',
        destination: join(root, 'safe-template'),
        workingDirectory: root
      })
    ).resolves.toMatch(/^[0-9a-f]{40}$/)
  })

  it('refuses submodules before writing package files and preserves nonempty destinations', async () => {
    const object = await git(['rev-parse', 'HEAD'])
    await git(['update-index', '--add', '--cacheinfo', `160000,${object},module`])
    await git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'gitlink fixture'])
    const destination = join(root, 'refused')
    await expect(
      checkoutPluginGitSource({ url, ref: '', destination, workingDirectory: root })
    ).rejects.toThrow('submodules')
    expect(await readdir(destination)).toEqual([])
    const keep = join(destination, 'keep.txt')
    await writeFile(keep, 'preserve')
    await expect(
      checkoutPluginGitSource({ url, ref: '', destination, workingDirectory: root })
    ).rejects.toThrow('must be empty')
    expect(await readFile(keep, 'utf8')).toBe('preserve')
  })
})
