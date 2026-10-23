import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('applies a supported terminal command marker within a 64 MiB heap', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-command-marker-memory-'))
  try {
    const child = join(directory, 'marker.cjs')
    await build({
      stdin: {
        contents: `
          import { appendCommandMarkerCache, applyCommandMarkerBoundaries } from './src/renderer/src/components/native-chat/native-chat-command-marker';
          import { classifyNativeChatSend, getAgentSlashCommands } from './src/shared/native-chat-slash-commands';
          import { buildNativeChatPasteBytes } from './src/shared/native-chat-paste-bytes';
          import { assertTerminalInputWithinLimit } from './src/shared/terminal-input';
          import { createHash } from 'node:crypto';
          const command = '/compact ' + 'ROW '.repeat(2_100_000).trimEnd();
          if (classifyNativeChatSend(command, getAgentSlashCommands('claude'), null, '/') !== 'command') {
            throw new Error('Fixture is not a supported command');
          }
          const payload = assertTerminalInputWithinLimit(buildNativeChatPasteBytes(command));
          const markers = appendCommandMarkerCache({ paneKey: 'memory', agent: 'claude', sessionId: 'session' }, command, 10);
          const messages = [{ id: 'prior', role: 'assistant', blocks: [{ type: 'text', text: 'reply' }], timestamp: 1, source: 'file' }];
          const result = applyCommandMarkerBoundaries(messages, markers);
          console.log(JSON.stringify({ retained: result === messages, bytes: Buffer.byteLength(payload), sha256: createHash('sha256').update(markers[0].command).digest('hex') }));
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
      retained: true,
      bytes: 8_400_008,
      sha256: '4709c3e7b00591b6337b39a9a85b132f217bd97319614156a28f7a031954b0cf'
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
