import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it.each(['message', 'setup'])(
  'normalizes complete CRLF %s output within a 64 MiB heap',
  async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-crlf-output-memory-'))
    try {
      const child = join(directory, 'normalize-output.cjs')
      await build({
        stdin: {
          contents: `
          import { finalizeFromAgentOutput } from './src/main/text-generation/source-control-agent-failure';
          import { MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES } from './src/main/text-generation/source-control-generation-limits';
          import { buildPosixRunnerScript } from './src/main/setup-runner-script-text';
          import { createHash } from 'node:crypto';
          const mode = process.argv[2];
          const source = mode === 'message' ? 'x\\r\\n'.repeat(1_300_000) : '#\\r\\n'.repeat(3_000_000);
          if (mode === 'message' && Buffer.byteLength(source) > MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES) {
            throw new Error('Fixture exceeds supported agent output');
          }
          const result = mode === 'setup' ? buildPosixRunnerScript(source)
            : finalizeFromAgentOutput({ code: 0, stdout: source, stderr: '', label: 'custom', emptyResultName: 'message' }).rawOutput;
          console.log(JSON.stringify({ bytes: Buffer.byteLength(result), sha256: createHash('sha256').update(result).digest('hex') }));
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
        args: ['--max-old-space-size=64', child, mode],
        env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
        timeoutMs: 15_000,
        maxOutputBytes: 4096
      })
      expect(result.timedOut).toBe(false)
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual(
        mode === 'message'
          ? {
              bytes: 2_599_999,
              sha256: '9e0f0e2a19e93ee224cf16fe0356a8b69a1021c238dba81ba617ea86d6a6791d'
            }
          : {
              bytes: 6_000_028,
              sha256: '76362689be5134caea66b380ba3a8ac8390546eb44885cfe79174179364024c4'
            }
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
