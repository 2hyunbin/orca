import { runProcess } from '@orca/process-host'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('rejects a 50 MiB remote save within a 96 MiB heap while preserving its exact size error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-remote-save-memory-'))
  try {
    const child = join(root, 'save.cjs')
    await build({
      stdin: {
        contents: `
          import { assertRemoteWriteFitsOneRequest } from './src/renderer/src/runtime/remote-file-write-size';
          const content = '\\u001b'.repeat(50 * 1024 * 1024);
          let message;
          try { assertRemoteWriteFitsOneRequest(content); }
          catch (error) { message = error.message; }
          if (!message) throw new Error('Oversized save accepted');
          console.log(JSON.stringify({ message }));
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
      args: ['--max-old-space-size=96', child],
      env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 15_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      message: 'File is too large to save to a remote Orca server (307201 KB; the limit is 720 KB).'
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
