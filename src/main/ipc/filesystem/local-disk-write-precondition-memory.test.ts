import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('checks an unchanged 45 MB save without encoding a second full copy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-disk-save-memory-'))
  try {
    const filePath = join(root, 'document.txt')
    writeFileSync(filePath, 'log entry 😊\n'.repeat(3_000_000))
    const child = join(root, 'save.mjs')
    await build({
      stdin: {
        contents: `
          import { createHash } from 'node:crypto';
          import { createReadStream } from 'node:fs';
          import { writeLocalTextFileWithDiskPrecondition } from './src/main/ipc/filesystem/local-disk-write-precondition';
          const content = 'log entry 😊\\n'.repeat(3_000_000);
          const before = process.memoryUsage().arrayBuffers;
          const result = await writeLocalTextFileWithDiskPrecondition(process.argv[2], content, {
            expectedSignature: 'an older baseline', requireLosslessUtf8: true
          });
          const arrayBufferGrowth = process.memoryUsage().arrayBuffers - before;
          const hash = createHash('sha256');
          let bytes = 0;
          for await (const chunk of createReadStream(process.argv[2])) {
            bytes += chunk.length;
            hash.update(chunk);
          }
          console.log(JSON.stringify({ result, arrayBufferGrowth, bytes, digest: hash.digest('hex') }));
        `,
        resolveDir: process.cwd()
      },
      outfile: child,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'silent'
    })
    const result = await runProcess({
      program: process.execPath,
      args: ['--max-old-space-size=128', child, filePath],
      env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 15_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    const output: {
      result: unknown
      arrayBufferGrowth: number
      bytes: number
      digest: string
    } = JSON.parse(result.stdout)
    expect(output).toMatchObject({
      result: { ok: true, unchanged: true },
      bytes: 45_000_000,
      digest: 'b522d0210a9d4b55be58f2cb32fbea928c3b3b2964fd80a1cef541a2e66fdd07'
    })
    expect(output.arrayBufferGrowth).toBeLessThan(55 * 1024 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
