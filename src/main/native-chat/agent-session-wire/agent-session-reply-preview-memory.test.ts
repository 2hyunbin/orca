import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it.each(['reply', 'user'])(
  'reads a complete Codex %s outline within a 64 MiB heap',
  async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-reply-preview-memory-'))
    try {
      const child = join(directory, 'read-outline.cjs')
      await build({
        stdin: {
          contents: `
          import { codexItemBody } from './src/main/codex/codex-structured-item-translation';
          import { readAgentSessionConversationOutline } from './src/main/native-chat/agent-session-wire/agent-session-conversation-outline';
          import { nativeChatUserMessagePreview } from './src/shared/agent-session-conversation-outline';
          import { createHash } from 'node:crypto';
          const mode = process.argv[2];
          const text = mode === 'user' ? 'a '.repeat(3_900_000) : '**x** '.repeat(1_300_000);
          const body = codexItemBody(mode === 'user'
            ? { id: 'user', type: 'userMessage', content: [{ type: 'text', text }] }
            : { id: 'reply', type: 'agentMessage', text });
          if (body?.kind !== 'message' || body.blocks[0]?.type !== 'text') {
            throw new Error('Missing complete reply');
          }
          const outline = readAgentSessionConversationOutline({ sessionId: 'preview',
            cursor: { epoch: 'epoch', sequence: mode === 'user' ? 1 : 2 }, submissions: [], items: mode === 'user'
              ? [{ itemId: 'user-1', revision: 1, sequence: 1, observedAt: 1, body }] : [
              { itemId: 'user-1', revision: 1, sequence: 1, observedAt: 1,
                body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Summarize this' }] } },
              { itemId: 'reply-2', revision: 1, sequence: 2, observedAt: 2, body }
            ] });
          const preview = mode === 'user' ? nativeChatUserMessagePreview(body.blocks).text : null;
          console.log(JSON.stringify({ outline, userPreview: preview === null ? null : { bytes: Buffer.byteLength(preview),
            sha256: createHash('sha256').update(preview).digest('hex') }, retainedBytes: Buffer.byteLength(body.blocks[0].text),
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
        args: ['--max-old-space-size=64', child, mode],
        env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
        timeoutMs: 15_000,
        maxOutputBytes: 4096
      })
      expect(result.timedOut).toBe(false)
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        outline: {
          sessionId: 'preview',
          cursor: { epoch: 'epoch', sequence: mode === 'user' ? 1 : 2 },
          entries: [
            {
              itemId: 'user-1',
              sequence: 1,
              preview: mode === 'user' ? `${'a '.repeat(99)}a` : 'Summarize this',
              imageCount: 0,
              ...(mode === 'user' ? {} : { reply: `${'x '.repeat(99)}x` })
            }
          ],
          omittedEntries: 0
        },
        userPreview:
          mode === 'user'
            ? {
                bytes: 7_799_999,
                sha256: 'a041bc6b55f7b07db8a5a086784765f8c5fbaf3600b8065d19a65657bcde3c2f'
              }
            : null,
        retainedBytes: 7_800_000,
        retainedSha256:
          mode === 'user'
            ? '5207754305264e3d1ffc70d944de90980dfe8cd97089d0a15f7ffb0bca2258b9'
            : '9e394f915746169ae1bf73637bb53cffa4bb5e6714ef6b22ae1fc211ac6a9982'
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
