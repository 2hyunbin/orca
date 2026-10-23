import { runProcess } from '@orca/process-host'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { AGENT_TUI_CLEAR_INPUT_MAX } from './agent-tui-input-clear'

it('schedules and clears a supported newline-heavy terminal paste within a 64 MiB heap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-prompt-line-memory-'))
  try {
    const child = join(root, 'schedule.cjs')
    await build({
      stdin: {
        contents: `
          import { resolveAgentPromptSubmitDelayForAgent } from './src/shared/agent-prompt-injection';
          import { countAgentTuiInputLines, buildAgentTuiClearInputForText } from './src/shared/agent-tui-input-clear';
          import { assertTerminalInputWithinLimit } from './src/shared/terminal-input';
          const prompt = 'progress\\n'.repeat(1_700_000);
          assertTerminalInputWithinLimit(prompt);
          const delay = resolveAgentPromptSubmitDelayForAgent('linux', prompt, 'claude');
          const lines = countAgentTuiInputLines(prompt);
          const clear = buildAgentTuiClearInputForText(prompt);
          console.log(JSON.stringify({ delay, lines, clear, rss: process.memoryUsage().rss }));
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
    const output: { delay: number; lines: number; clear: string; rss: number } = JSON.parse(
      result.stdout
    )
    expect(output).toMatchObject({
      delay: 4236,
      lines: 1_700_001,
      clear: AGENT_TUI_CLEAR_INPUT_MAX
    })
    expect(output.rss).toBeLessThan(160 * 1024 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
