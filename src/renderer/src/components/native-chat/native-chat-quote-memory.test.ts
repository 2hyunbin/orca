import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('quotes a complete multiline reply within a 64 MiB heap', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-native-chat-quote-memory-'))
  try {
    const child = join(directory, 'quote.cjs')
    await build({
      stdin: {
        contents: `
          import { formatNativeChatQuote } from './src/renderer/src/components/native-chat/native-chat-quote-selection';
          import { createHash } from 'node:crypto';
          const source = 'row\\n'.repeat(2_100_000);
          const sourceSha = createHash('sha256').update(source).digest('hex');
          const quoted = formatNativeChatQuote(source);
          console.log(JSON.stringify({ sourceSha, bytes: Buffer.byteLength(quoted), sha256: createHash('sha256').update(quoted).digest('hex') }));
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
      sourceSha: 'b6c88dddf2cd4446e64b36ede266650fb8fa794f5f87840545162ec8eb1bba60',
      bytes: 12_600_001,
      sha256: '378eb5d950a9c8e7a3ec1b1fbed314343dafcfac56e5e5d7adba7ea995ba4152'
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
