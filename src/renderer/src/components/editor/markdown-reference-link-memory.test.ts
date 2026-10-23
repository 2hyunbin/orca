import { runProcess } from '@orca/process-host'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('normalizes complete large Markdown documents within a 64 MiB heap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-markdown-reference-memory-'))
  try {
    const child = join(root, 'references.cjs')
    await build({
      stdin: {
        contents: `
          import { createHash } from 'node:crypto';
          import { normalizeMarkdownReferenceLinks } from './src/renderer/src/components/editor/markdown-reference-link-normalization';
          const documents = [
            '# Reference document\\n\\n<div>summary</div>\\n\\n[Docs]\\n\\n' +
              ('a'.repeat(4096) + '\\n').repeat(2048) +
              'End 😊\\n\\n[docs]: https://example.com/docs "Title"\\n',
            '<div>summary</div>\\n' + 'a\\n'.repeat(4194304)
          ];
          const outputs = documents.map(content => {
            const output = normalizeMarkdownReferenceLinks(content);
            return {
              length: output.length,
              digest: createHash('sha256').update(output).digest('hex')
            };
          });
          console.log(JSON.stringify({ outputs, peakRss: process.resourceUsage().maxRSS * 1024 }));
        `,
        resolveDir: process.cwd()
      },
      outfile: child,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      logLevel: 'silent'
    })
    const result = await runProcess({
      program: process.execPath,
      args: ['--max-old-space-size=64', child],
      env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 15_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    const output: {
      outputs: { length: number; digest: string }[]
      peakRss: number
    } = JSON.parse(result.stdout)
    expect(output.outputs).toEqual([
      {
        length: 8_390_748,
        digest: '03e74c28c583f205337ae47af88ce063b98c66ea45cd0aa5758357a6675e5e54'
      },
      {
        length: 8_388_627,
        digest: 'a535c0e484c4edb250929da38fb9bfa047bdd42c51c37f7875663c23ce6b6b22'
      }
    ])
    expect(output.peakRss).toBeLessThan(200 * 1024 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
