import { runProcess } from '@orca/process-host'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('evaluates a large startup line within a 64 MiB heap without changing the prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-startup-line-budget-memory-'))
  try {
    const child = join(root, 'startup.cjs')
    await build({
      stdin: {
        contents: `
          import { createHash } from 'node:crypto';
          import { buildAgentStartupPlan } from './src/shared/tui-agent-startup';
          import { startupLineCarriesPrompt } from './src/shared/startup-line-prompt-carry';
          const base = buildAgentStartupPlan({
            agent: 'claude', platform: 'darwin', cmdOverrides: {}, prompt: 'seed'
          });
          if (!base) throw new Error('missing base startup plan');
          const launchCommand = "claude '" + 'step\\n'.repeat(1677722) + "Final instruction 😊'";
          const withPrompt = { ...base, launchCommand };
          const carried = startupLineCarriesPrompt({
            agent: 'claude', withPrompt, shellName: 'zsh', hostProvesAgentInFront: true
          });
          const carriedWithoutForegroundProof = startupLineCarriesPrompt({
            agent: 'claude', withPrompt, shellName: 'zsh', hostProvesAgentInFront: false
          });
          console.log(JSON.stringify({
            carried, carriedWithoutForegroundProof,
            length: withPrompt.launchCommand.length,
            digest: createHash('sha256').update(withPrompt.launchCommand).digest('hex'),
            peakRss: process.resourceUsage().maxRSS * 1024
          }));
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
      carried: boolean
      carriedWithoutForegroundProof: boolean
      length: number
      digest: string
      peakRss: number
    } = JSON.parse(result.stdout)
    expect(output).toMatchObject({
      carried: false,
      carriedWithoutForegroundProof: true,
      length: 8_388_639,
      digest: 'b601d3b12ec0b4c5f27e3e7185b20618c7eb861c145b8c45480d75206870ce42'
    })
    expect(output.peakRss).toBeLessThan(160 * 1024 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
