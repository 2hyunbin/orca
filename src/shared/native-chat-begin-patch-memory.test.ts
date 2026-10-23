import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('builds every card from a supported Codex patch record within a 32 MiB heap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-begin-patch-memory-'))
  try {
    const child = join(root, 'patch.cjs')
    await build({
      stdin: {
        contents: `
          import { createHash } from 'node:crypto';
          import { decodeCodexTranscriptLine } from './src/main/native-chat/transcript-line-decoders-codex';
          import { buildEditCards } from './src/shared/native-chat-edit-cards';
          const patch = '*** Begin Patch\\n*** Add File: generated.txt\\n'
            + '+a\\n'.repeat(490_000)
            + '*** Update File: old.txt\\n*** Move to: new.txt\\n@@ -1 +1 @@\\n-old\\n+new\\n*** End Patch';
          const line = JSON.stringify({ type: 'response_item', payload: {
            type: 'custom_tool_call', name: 'apply_patch', input: patch, call_id: 'call'
          }});
          const call = decodeCodexTranscriptLine(line, 'call');
          const result = decodeCodexTranscriptLine(JSON.stringify({
            type: 'response_item', payload: {
              type: 'custom_tool_call_output', call_id: 'call', output: 'Success'
            }
          }), 'result');
          const cards = buildEditCards([...call.blocks, ...result.blocks]);
          const files = [...cards.editCards.values()].map(card => card.files);
          console.log(JSON.stringify({
            recordBytes: Buffer.byteLength(line),
            digest: createHash('sha256').update(JSON.stringify(files)).digest('hex')
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
    const output: { recordBytes: number; digest: string } = JSON.parse(result.stdout)
    expect(output.recordBytes).toBe(1_960_243)
    expect(output.recordBytes).toBeLessThan(2 * 1024 * 1024)
    expect(output.digest).toBe('15f98f20c6e467f5ba1666e3cb9ea93d55b535c1492b7afe6e75e5238875260e')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
