import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('selects a Jira summary from supported multiline output within a 24 MiB heap', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-jira-summary-memory-'))
  try {
    const child = join(directory, 'jira-summary.cjs')
    await build({
      stdin: {
        contents: `
          import { sanitizeGeneratedJiraIssueSummary } from './src/shared/jira/jira-issue-summary-generation';
          import { finalizeFromAgentOutput } from './src/main/text-generation/source-control-agent-failure';
          import { MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES } from './src/main/text-generation/source-control-generation-limits';
          import { createHash } from 'node:crypto';
          const source = 'Title\\n' + 'a\\n'.repeat(1_800_000);
          if (Buffer.byteLength(source) > MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES) {
            throw new Error('Fixture exceeds supported agent output');
          }
          const result = finalizeFromAgentOutput({ code: 0, stdout: source, stderr: '', label: 'custom', emptyResultName: 'summary' });
          if (!result.success) throw new Error(result.error);
          const summary = sanitizeGeneratedJiraIssueSummary(result.rawOutput);
          console.log(JSON.stringify({ summary, bytes: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex') }));
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
      args: ['--max-old-space-size=24', child],
      env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 15_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      summary: 'Title',
      bytes: 3_600_006,
      sha256: '4cfe5fcd098e594de6c1aabe9113e430f42d01bec4145632a70657a2fcf3ec82'
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
