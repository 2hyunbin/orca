import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it.each([
  {
    name: 'CRLF lines',
    chunk: 'a\r\n',
    count: 4_000_000,
    sourceSha256: 'e78e19be1b0272a6b7556a516d9c71560ae875e65fa0aa22c2c69733efe732d1',
    storedSha256: '3a900863044441c7a2f89b870c8cd876a64b53ad994a268e4c924e3d9383bfa3'
  },
  {
    name: 'progress rewrites',
    chunk: '10%\r100%\n',
    count: 1_000_000,
    sourceSha256: 'acbbefef62236496e540fb6ef9df32200cbcde500a5fb625bb5bf6115ff3335d',
    storedSha256: '10244b1a0ad0cad153bdca96dd1dd77b08393295699be78d7677ddef96b5b49d'
  }
])('preserves all large $name within a 96 MiB renderer heap', async (fixture) => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-notebook-stream-memory-'))
  try {
    const child = join(directory, 'notebook-stream.cjs')
    await build({
      stdin: {
        contents: `
          import { applyKernelOutput, toStoredOutputs } from './src/renderer/src/components/editor/ipynb-kernel-outputs';
          import { createHash } from 'node:crypto';
          Reflect.deleteProperty(globalThis, 'Buffer');
          const text = ${JSON.stringify(fixture.chunk)}.repeat(${fixture.count});
          let live = applyKernelOutput({ outputs: [], clearOnNextOutput: false }, 'stream', {
            name: 'stdout', text: 'completed prefix\\n'
          });
          live = applyKernelOutput(live, 'stream', { name: 'stdout', text: text + '10%\\r20%\\r' });
          live = applyKernelOutput(live, 'stream', { name: 'stdout', text: '100%\\n' });
          console.log(JSON.stringify({
            sourceLength: text.length,
            sourceSha256: createHash('sha256').update(text).digest('hex'),
            storedSha256: createHash('sha256').update(JSON.stringify(toStoredOutputs(live.outputs))).digest('hex')
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
      args: ['--max-old-space-size=96', child],
      env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 20_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      sourceLength: fixture.chunk.length * fixture.count,
      sourceSha256: fixture.sourceSha256,
      storedSha256: fixture.storedSha256
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
