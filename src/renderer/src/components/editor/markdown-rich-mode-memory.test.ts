import { runProcess } from '@orca/process-host'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('classifies complete large Markdown documents within a 192 MiB heap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-markdown-rich-mode-memory-'))
  try {
    const child = join(root, 'eligibility.cjs')
    await build({
      stdin: {
        contents: `
          import { getMarkdownRichModeEligibilityDecision } from './src/renderer/src/components/editor/markdown-rich-mode';
          const body = 'a\\n'.repeat(4194304);
          const fence = String.fromCharCode(96).repeat(3);
          const decisions = [body, fence + 'ts\\n' + body + fence + '\\n'].map(content =>
            getMarkdownRichModeEligibilityDecision({ content, sizeOverridden: false })
          );
          console.log(JSON.stringify({ decisions, peakRss: process.resourceUsage().maxRSS * 1024 }));
        `,
        resolveDir: process.cwd()
      },
      outfile: child,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      minify: true,
      jsx: 'automatic',
      alias: { '@': resolve('src/renderer/src') },
      define: {
        'process.env.NODE_ENV': '"production"',
        'import.meta.env': '{}',
        'import.meta.hot': 'undefined'
      },
      loader: {
        '.wasm': 'binary',
        '.css': 'empty',
        '.png': 'text',
        '.svg': 'text',
        '.webp': 'text'
      },
      logLevel: 'silent'
    })
    const result = await runProcess({
      program: process.execPath,
      args: ['--max-old-space-size=192', child],
      env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 15_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    const output: {
      decisions: { exceedsSizeLimit: boolean; unsupportedReason: string | null }[]
      peakRss: number
    } = JSON.parse(result.stdout)
    expect(output.decisions).toEqual([
      { exceedsSizeLimit: true, unsupportedReason: null },
      { exceedsSizeLimit: true, unsupportedReason: null }
    ])
    expect(output.peakRss).toBeLessThan(600 * 1024 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
