import { runProcess } from '@orca/process-host'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('preserves a complete large startup prompt within a 64 MiB heap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-startup-argument-memory-'))
  try {
    const child = join(root, 'startup.cjs')
    await build({
      stdin: {
        contents: `
          import { createHash } from 'node:crypto';
          import { buildAgentStartupPlan } from './src/shared/tui-agent-startup';
          const prompt = ('a'.repeat(4096) + "\\n'\\\\").repeat(2048) + 'Final instruction 😊';
          const plan = buildAgentStartupPlan({
            agent: 'claude', platform: 'darwin', cmdOverrides: {}, prompt
          });
          if (!plan) throw new Error('missing startup plan');
          console.log(JSON.stringify({
            length: plan.launchCommand.length,
            digest: createHash('sha256').update(plan.launchCommand).digest('hex'),
            followupPrompt: plan.followupPrompt,
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
    const output: { length: number; digest: string; followupPrompt: null; peakRss: number } =
      JSON.parse(result.stdout)
    expect(output).toMatchObject({
      length: 8_409_117,
      digest: '17b0749e3c6f84c90eaa6e2cc84132c4a97d939a38471f8ed53020f153174d18',
      followupPrompt: null
    })
    expect(output.peakRss).toBeLessThan(200 * 1024 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
