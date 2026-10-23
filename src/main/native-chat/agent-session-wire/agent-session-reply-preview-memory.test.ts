import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('reads a complete Codex reply outline within a 64 MiB heap', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-reply-preview-memory-'))
  try {
    const child = join(directory, 'read-outline.cjs')
    await build({
      stdin: {
        contents: `
          import { codexItemBody } from './src/main/codex/codex-structured-item-translation';
          import { readAgentSessionConversationOutline } from './src/main/native-chat/agent-session-wire/agent-session-conversation-outline';
          import { createHash } from 'node:crypto';
          const text = '**x** '.repeat(1_300_000);
          const body = codexItemBody({ id: 'reply', type: 'agentMessage', text });
          if (body?.kind !== 'message' || body.blocks[0]?.type !== 'text') {
            throw new Error('Missing complete reply');
          }
          const outline = readAgentSessionConversationOutline({ sessionId: 'preview',
            cursor: { epoch: 'epoch', sequence: 2 }, submissions: [], items: [
              { itemId: 'user-1', revision: 1, sequence: 1, observedAt: 1,
                body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Summarize this' }] } },
              { itemId: 'reply-2', revision: 1, sequence: 2, observedAt: 2, body }
            ] });
          console.log(JSON.stringify({ outline, retainedBytes: Buffer.byteLength(body.blocks[0].text),
            retainedSha256: createHash('sha256').update(body.blocks[0].text).digest('hex') }));
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
      outline: {
        sessionId: 'preview',
        cursor: { epoch: 'epoch', sequence: 2 },
        entries: [
          {
            itemId: 'user-1',
            sequence: 1,
            preview: 'Summarize this',
            imageCount: 0,
            reply: `${'x '.repeat(99)}x`
          }
        ],
        omittedEntries: 0
      },
      retainedBytes: 7_800_000,
      retainedSha256: '9e394f915746169ae1bf73637bb53cffa4bb5e6714ef6b22ae1fc211ac6a9982'
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
