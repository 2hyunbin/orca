import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it.each([
  {
    kind: 'ansi',
    byteLength: 10_800_012,
    digest: '6d088d6f382be965e408a13204efd39ab756476f5100fc5af07a098fe6ecc533'
  },
  {
    kind: 'newlines',
    byteLength: 7_920_012,
    digest: '9e9c012a750dcab2da4bf79febad7e6a4c11f85b5d59a2b821e9b3ec7cb6e5e1'
  }
])('frames a complete supported $kind paste within a 96 MiB heap', async (fixture) => {
  const root = mkdtempSync(join(tmpdir(), 'orca-bracketed-paste-memory-'))
  try {
    const child = join(root, 'paste.cjs')
    await build({
      stdin: {
        contents: `
          import { createHash } from 'node:crypto';
          import { wrapTerminalBracketedPasteText } from './src/shared/terminal-bracketed-paste-text';
          import { assertTerminalInputWithinLimit } from './src/shared/terminal-input';
          const text = process.argv[2] === 'ansi'
            ? '\\x1b[31mX\\x1b[0m\\n'.repeat(720_000)
            : '\\n'.repeat(7_920_000);
          const framed = wrapTerminalBracketedPasteText(text);
          assertTerminalInputWithinLimit(framed);
          console.log(JSON.stringify({
            length: framed.length, byteLength: Buffer.byteLength(framed),
            digest: createHash('sha256').update(framed).digest('hex'),
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
      args: ['--max-old-space-size=96', child, fixture.kind],
      env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 15_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    const output: { length: number; byteLength: number; digest: string; peakRss: number } =
      JSON.parse(result.stdout)
    expect(output).toMatchObject({
      length: 7_920_012,
      byteLength: fixture.byteLength,
      digest: fixture.digest
    })
    expect(output.peakRss).toBeLessThan(240 * 1024 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
