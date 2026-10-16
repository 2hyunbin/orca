import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createGitProgressRecordReader, type GitProgressRecord } from './git-progress-records'

export function registerGitWorktreeProgressBinaryCompatibilityCase(
  runGit: (args: string[], env?: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>,
  getRepoPath: () => string
): void {
  // Why pin this: the create card reads the checkout meter `worktree add` writes into a pipe
  // unasked (it has no --progress flag), so the record format is a contract with every Git.
  it('writes checkout progress records into a pipe during worktree add', async () => {
    const repoPath = getRepoPath()
    const fileCount = 120
    const source = join(repoPath, 'progress-source')
    await mkdir(source)
    try {
      await Promise.all(
        Array.from({ length: fileCount }, (_, index) =>
          writeFile(join(source, `file-${index}.txt`), `${index}\n`)
        )
      )
      await runGit(['-C', 'progress-source', 'init', '-q'])
      await runGit(['-C', 'progress-source', 'add', '.'])
      await runGit([
        '-C',
        'progress-source',
        '-c',
        'user.name=Compatibility Test',
        '-c',
        'user.email=compatibility@example.invalid',
        'commit',
        '-qm',
        'files'
      ])
      // Why the env: git otherwise waits ~1 s before its first record, longer than this checkout.
      const { stderr } = await runGit(
        ['-C', 'progress-source', 'worktree', 'add', '-b', 'compat-progress', '../progress-wt'],
        { GIT_PROGRESS_DELAY: '0' }
      )
      const records: GitProgressRecord[] = []
      createGitProgressRecordReader('Updating files', (record) => records.push(record))(stderr)

      expect(records.length).toBeGreaterThan(1)
      expect(records.at(-1)).toEqual({
        percent: 100,
        completed: fileCount,
        total: fileCount,
        done: true
      })
      const completed = records.map((record) => record.completed)
      expect(completed).toEqual([...completed].sort((left, right) => left - right))
    } finally {
      await rm(source, { recursive: true, force: true })
      await rm(join(repoPath, 'progress-wt'), { recursive: true, force: true })
    }
  })
}
