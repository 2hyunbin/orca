import { runProcess } from '@orca/process-host'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('keeps every prose line while removing a visual from a large reply within a 64 MiB heap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-visual-copy-memory-'))
  try {
    const child = join(root, 'copy.cjs')
    await build({
      stdin: {
        contents: `
          import { createHash } from 'node:crypto';
          import { withoutNativeChatVisualDirectiveLines } from './src/shared/native-chat-visual-directive';
          const text = 'progress\\n'.repeat(1_000_000) + '\\n::orca-visual{file="usage.html"}\\n\\nPreserve the final message 😊';
          const copied = withoutNativeChatVisualDirectiveLines(text);
          console.log(JSON.stringify({
            length: copied.length,
            digest: createHash('sha256').update(copied).digest('hex'),
            peakRss: process.resourceUsage().maxRSS * 1024
          }));
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
    const output: { length: number; digest: string; peakRss: number } = JSON.parse(result.stdout)
    expect(output).toMatchObject({
      length: 9_000_030,
      digest: 'fa13ef4695cbbf845528f7257c2d646ab6e9304a5ccbd5c7a41d6e6cc23fd5af'
    })
    expect(output.peakRss).toBeLessThan(180 * 1024 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
