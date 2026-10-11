import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'

export function registerGitSourceExportBinaryCompatibilityCase(
  runGit: (args: string[], env?: NodeJS.ProcessEnv, stdin?: string) => Promise<{ stdout: string }>,
  repoPath: () => string,
  container: boolean
): void {
  it('exports tracked source and rebuilds an independent index with baseline Git commands', async () => {
    const root = join(repoPath(), 'source-export-contract')
    const hostRoot = container ? '/repo/source-export-contract' : root
    await mkdir(root)
    const git = (args: string[], stdin?: string) =>
      runGit(['-C', hostRoot, ...args], undefined, stdin)
    try {
      await git(['init', '-q'])
      await git(['config', 'user.name', 'Test'])
      await git(['config', 'user.email', 'test@example.invalid'])
      await writeFile(join(root, '.gitattributes'), '*.txt text eol=crlf\n')
      await writeFile(join(root, 'text.txt'), 'committed\n')
      await git(['add', '.'])
      await git(['commit', '-qm', 'seed'])
      await rm(join(root, '.gitattributes'))
      await rm(join(root, 'text.txt'))
      await git(['read-tree', '--empty'])
      await git(['reset', '--mixed', '-q', 'HEAD'])
      const attributes = await git(
        ['check-attr', '--cached', '--all', '-z', '--stdin'],
        'text.txt\0'
      )
      expect(attributes.stdout).toContain('text.txt\0eol\0crlf\0')
      await git(['checkout-index', '--all', '--prefix=export/'])
      expect(await readFile(join(root, 'export', 'text.txt'), 'utf8')).toBe('committed\r\n')
      await writeFile(join(root, 'text.txt'), await readFile(join(root, 'export', 'text.txt')))
      await writeFile(
        join(root, '.gitattributes'),
        await readFile(join(root, 'export', '.gitattributes'))
      )
      await git(['update-index', '--refresh'])
      await git(['reset', '--hard', 'HEAD'])
      expect((await git(['ls-files', '--stage', '-z'])).stdout).toContain('\ttext.txt\0')
      expect((await git(['config', '--null', '--list'])).stdout).toContain('user.name\nTest\0')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
