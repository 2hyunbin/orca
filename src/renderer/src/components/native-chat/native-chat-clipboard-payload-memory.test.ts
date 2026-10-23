import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('keeps complete supported paste text beside an image within a 32 MiB heap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-clipboard-label-memory-'))
  try {
    const child = join(root, 'paste.cjs')
    await build({
      stdin: {
        contents: `
          import { createHash } from 'node:crypto';
          import { clipboardEventPromptText } from './src/renderer/src/components/native-chat/native-chat-clipboard-payload';
          import { assertClipboardTextWithinLimit } from './src/shared/clipboard-text';
          const text = 'image.png\\n' + 'progress\\n'.repeat(1_000_000) + 'Final instruction 😊';
          const event = {
            defaultPrevented: false,
            preventDefault() {},
            clipboardData: {
              files: [new File(['image'], 'image.png', { type: 'image/png' })],
              getData: type => type === 'text/plain' ? text : ''
            }
          };
          const output = clipboardEventPromptText(event, true);
          assertClipboardTextWithinLimit(output);
          console.log(JSON.stringify({
            length: output.length, byteLength: Buffer.byteLength(output),
            digest: createHash('sha256').update(output).digest('hex')
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
      args: ['--max-old-space-size=32', child],
      env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 15_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    const output: { length: number; byteLength: number; digest: string } = JSON.parse(result.stdout)
    expect(output).toEqual({
      length: 9_000_030,
      byteLength: 9_000_032,
      digest: 'dfbf61aef4541642f377069e63f734d1bd9817f1115d1c862a45363b81dd603e'
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
