import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('selects a branch slug from supported agent output within a 64 MiB heap', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-branch-name-memory-'))
  try {
    const child = join(directory, 'branch-name.cjs')
    await build({
      stdin: {
        contents: `
          import { sanitizeBranchSlug } from './src/shared/branch-name-from-work';
          import { finalizeFromAgentOutput } from './src/main/text-generation/source-control-agent-failure';
          import { MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES } from './src/main/text-generation/source-control-generation-limits';
          import { createHash } from 'node:crypto';
          const source = 'Fix login flow now\\n' + 'row!'.repeat(975_000);
          if (Buffer.byteLength(source) > MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES) throw new Error('Unsupported agent output');
          const result = finalizeFromAgentOutput({ code: 0, stdout: source, stderr: '', label: 'custom', emptyResultName: 'branch name' });
          if (!result.success) throw new Error(result.error);
          const slug = sanitizeBranchSlug(result.rawOutput);
          console.log(JSON.stringify({ slug, sourceBytes: Buffer.byteLength(source), sourceSha256: createHash('sha256').update(source).digest('hex') }));
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
    expect(JSON.parse(result.stdout)).toEqual({
      slug: 'fix-login-flow-now',
      sourceBytes: 3_900_019,
      sourceSha256: '80154d694217c146a78c90baafa283eff2feba4490b9b3eaaff7f3c2cab7461b'
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
