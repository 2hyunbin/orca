import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('starts tailing a supported 45 MB log without encoding another full snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-log-offset-memory-'))
  try {
    const child = join(root, 'tail.cjs')
    await build({
      stdin: {
        contents: `
          import { createHash } from 'node:crypto';
          import { LocalLogTailDecoder } from './src/renderer/src/components/editor/local-log-tail-decoder';
          const snapshot = 'log entry 😊\\n'.repeat(3_000_000) + 'unfinished 🦀';
          const before = process.memoryUsage().arrayBuffers;
          const decoder = new LocalLogTailDecoder(snapshot, 'file-identity');
          const arrayBufferGrowth = process.memoryUsage().arrayBuffers - before;
          const byteOffset = decoder.nextByteOffset;
          const tail = Buffer.from('unfinished 🦀\\nnext\\n');
          const appended = decoder.apply({
            contentBase64: tail.toString('base64'), nextByteOffset: byteOffset + tail.length,
            fileSize: byteOffset + tail.length, fileIdentity: 'file-identity',
            hasMore: false, reset: false
          });
          console.log(JSON.stringify({
            arrayBufferGrowth, byteOffset, length: decoder.initialVisibleContent.length,
            digest: createHash('sha256').update(decoder.initialVisibleContent).digest('hex'),
            appended, finalByteOffset: decoder.nextByteOffset
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
      args: ['--max-old-space-size=128', child],
      env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 15_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    const output: {
      arrayBufferGrowth: number
      byteOffset: number
      length: number
      digest: string
      appended: unknown
      finalByteOffset: number
    } = JSON.parse(result.stdout)
    expect(output).toMatchObject({
      byteOffset: 45_000_000,
      length: 39_000_000,
      digest: 'b522d0210a9d4b55be58f2cb32fbea928c3b3b2964fd80a1cef541a2e66fdd07',
      appended: { kind: 'append', content: 'unfinished 🦀\nnext\n', hasMore: false },
      finalByteOffset: 45_000_021
    })
    expect(output.arrayBufferGrowth).toBeLessThan(4 * 1024 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
