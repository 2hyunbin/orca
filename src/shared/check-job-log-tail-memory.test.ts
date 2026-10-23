import { runProcess } from '@orca/process-host'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR } from './check-job-log-tail-slice'

it('extracts failure context from an 18 MiB log within a 64 MiB heap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-check-log-memory-'))
  try {
    const child = join(root, 'excerpt.cjs')
    await build({
      stdin: {
        contents: `
          import { sliceCheckLogTail } from './src/shared/check-job-log-tail-slice';
          const input = 'progress\\n'.repeat(2 * 1024 * 1024)
            + 'error: visible failure\\r\\n' + 'recent\\r'.repeat(120);
          const excerpt = sliceCheckLogTail(input);
          console.log(JSON.stringify({ excerpt, rss: process.memoryUsage().rss }));
        `,
        resolveDir: process.cwd()
      },
      outfile: child,
      bundle: true,
      platform: 'node',
      format: 'cjs',
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
    const output: { excerpt: string; rss: number } = JSON.parse(result.stdout)
    expect(output.excerpt).toBe(
      [
        'progress',
        'progress',
        'error: visible failure',
        'recent',
        'recent',
        PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR,
        ...Array.from({ length: 99 }, () => 'recent'),
        ''
      ].join('\n')
    )
    expect(output.rss).toBeLessThan(160 * 1024 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
