import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { runProcess } from '@orca/process-host'
import { tryMaterializeSharedWorktreeSource } from '../../../src/main/git/worktree-source-cache'

async function main() {
  const repoRoot = process.cwd()
  const [ref = 'HEAD', repetitionsArgument = '2'] = process.argv.slice(2)
  const repetitions = Number(repetitionsArgument)
  if (
    process.platform !== 'darwin' ||
    !Number.isInteger(repetitions) ||
    repetitions < 1 ||
    repetitions > 3
  ) {
    throw new Error(
      'Usage on APFS: pnpm exec tsx tests/tools/benchmarks/worktree-tracked-source-benchmark.ts REF [1..3]'
    )
  }
  async function git(cwd: string, args: string[]) {
    const result = await runProcess({
      program: 'git',
      args,
      cwd,
      timeoutMs: 180_000,
      terminationBarrier: true
    })
    if (result.code !== 0 || result.timedOut) {
      throw new Error(result.stderr || 'Git failed')
    }
    return result.stdout.trim()
  }
  const commit = await git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])
  const objects = resolve(repoRoot, await git(repoRoot, ['rev-parse', '--git-path', 'objects']))
  const scratch = await mkdtemp(join(dirname(repoRoot), '.orca-tracked-source-benchmark-'))
  const rows: { iteration: number; method: string; seconds: number; storage?: unknown }[] = []
  try {
    for (let iteration = 1; iteration <= repetitions; iteration += 1) {
      const repo = join(scratch, `repo-${iteration}`)
      await mkdir(repo)
      await git(repo, ['init', '-q'])
      await writeFile(join(repo, '.git', 'objects', 'info', 'alternates'), `${objects}\n`)
      await git(repo, ['config', 'core.autocrlf', 'false'])
      await git(repo, ['config', 'core.hooksPath', join(scratch, 'no-hooks')])
      const paths: string[] = []
      for (const method of ['ordinary', 'shared-cold', 'shared-warm']) {
        const worktree = join(scratch, `${method}-${iteration}`)
        paths.push(worktree)
        const start = performance.now()
        await git(repo, ['worktree', 'add', '--no-checkout', '--detach', worktree, commit])
        if (method !== 'ordinary') {
          const shared = await tryMaterializeSharedWorktreeSource(
            worktree,
            commit,
            {},
            async () => {},
            {
              platform: process.platform,
              env: { ...process.env, ORCA_EXPERIMENTAL_SOURCE_SHARING: '1' }
            }
          )
          if (!shared) {
            throw new Error('Sharing fell back to ordinary checkout; benchmark invalid')
          }
        }
        await git(worktree, ['reset', '--hard', commit])
        if (await git(worktree, ['status', '--porcelain'])) {
          throw new Error('Checkout is dirty')
        }
        rows.push({ iteration, method, seconds: (performance.now() - start) / 1000 })
      }
      const audit = await runProcess({
        program: 'python3',
        args: [
          join(repoRoot, 'tests/tools/benchmarks/worktree-storage-audit.py'),
          '--apfs-private',
          ...paths
        ],
        timeoutMs: 180_000,
        terminationBarrier: true
      })
      if (audit.code !== 0) {
        throw new Error(audit.stderr || 'Storage audit failed')
      }
      const parsed: unknown = JSON.parse(audit.stdout)
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('roots' in parsed) ||
        !Array.isArray(parsed.roots)
      ) {
        throw new Error('Invalid audit result')
      }
      const iterationRows = rows.filter((row) => row.iteration === iteration)
      for (let index = 0; index < paths.length; index += 1) {
        const root: unknown = parsed.roots[index]
        if (typeof root !== 'object' || root === null || !('totals' in root)) {
          throw new Error('Missing totals')
        }
        iterationRows[index].storage = root.totals
      }
      const seed = join(
        repo,
        '.git',
        'orca-cache',
        'tracked-source-v1',
        'seed',
        'source',
        'package.json'
      )
      const original = await readFile(seed)
      await writeFile(join(paths[2], 'package.json'), 'independent write\n')
      if (
        !(await readFile(seed)).equals(original) ||
        !(await readFile(join(paths[1], 'package.json'))).equals(original)
      ) {
        throw new Error('Write isolation failed')
      }
    }
    console.log(
      JSON.stringify(
        { commit, platform: process.platform, git: await git(repoRoot, ['--version']), rows },
        null,
        2
      )
    )
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
