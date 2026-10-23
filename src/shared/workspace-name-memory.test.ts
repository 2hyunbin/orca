import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it.each(['plain', 'dense'])(
  'derives a workspace seed from a supported large %s prompt within a 64 MiB heap',
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-workspace-name-memory-'))
    try {
      const child = join(root, 'workspace-name.cjs')
      await build({
        stdin: {
          contents: `
          import { slugifyForWorkspaceName } from './src/shared/workspace-name';
          import { createHash } from 'node:crypto';
          const prompt = ${mode === 'dense' ? "'a '.repeat(4_000_000)" : "'a'.repeat(8_000_000)"};
          const slug = slugifyForWorkspaceName(prompt);
          console.log(JSON.stringify({
            slug, promptLength: prompt.length,
            inputSha256: createHash('sha256').update(prompt).digest('hex'),
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
      const output: { slug: string; promptLength: number; peakRss: number } = JSON.parse(
        result.stdout
      )
      expect(output).toMatchObject({
        slug: mode === 'dense' ? `${'a-'.repeat(23)}a` : 'a'.repeat(48),
        promptLength: 8_000_000,
        inputSha256:
          mode === 'dense'
            ? '129c1aee8eb2a13495ac165f1920a8e874acdfed9b3feeb08cbaad33d917ae0a'
            : 'e10ff4eeb1e50e9782e8718d15b3b62c146d9564f42069d921cfa1f3d1ab06ac'
      })
      expect(output.peakRss).toBeLessThan(160 * 1024 * 1024)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
