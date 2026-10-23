import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('labels a completed Grok spawn with its full prompt within a 64 MiB heap', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-grok-subagent-label-'))
  try {
    const child = join(directory, 'grok-subagent-label.cjs')
    await build({
      stdin: {
        contents: `
          import { AcpTimelineTranslator } from './src/main/acp/acp-timeline-translator';
          import { GROK_ACP_DIALECT } from './src/main/acp/acp-dialects/grok-dialect';
          import { resolveAcpPeerOptions } from './src/main/acp/acp-peer-limits';
          import { createHash } from 'node:crypto';
          const prompt = 'Read notes\\n' + 'row\\n'.repeat(1_500_000);
          const update = {
            sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'spawn_subagent', rawInput: { prompt },
            _meta: { 'x.ai/tool': { version: 1, name: 'spawn_subagent', kind: 'task', namespace: 'grok_build', label: 'Subagent', read_only: false } }
          };
          const frame = JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-1', update } });
          if (Buffer.byteLength(frame) > resolveAcpPeerOptions().maxLineBytes) throw new Error('Unsupported frame');
          const lane = new AcpTimelineTranslator({ sessionId: 'session-1', dialect: GROK_ACP_DIALECT });
          lane.openPrompt('prompt-1', 0);
          lane.notification('session/update', { sessionId: 'session-1', update }, 1);
          const events = lane.notification('session/update', { sessionId: 'session-1', update: {
            sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed',
            rawOutput: { type: 'Text', text: 'Subagent started.\\nsubagent_id: subagent-1\\n' }
          } }, 2);
          const body = events.find(event => event.type === 'item.close')?.body;
          if (body?.kind !== 'tool-call' || typeof body.input?.prompt !== 'string') throw new Error('Missing full prompt');
          console.log(JSON.stringify({
            inputBytes: Buffer.byteLength(body.input.prompt),
            inputSha256: createHash('sha256').update(body.input.prompt).digest('hex'),
            evidence: lane.subagents.drainEvidence()
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
      args: ['--max-old-space-size=64', child],
      env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 15_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      inputBytes: 6_000_011,
      inputSha256: 'dc317b53c755490c6c2b4ce18ee0d7c5a7f5f4ead99eacd187a8412df6836d0e',
      evidence: [
        {
          type: 'live',
          observedAt: 2,
          child: {
            handle: { idKind: 'task_id', id: 'subagent-1' },
            kind: 'agent',
            residency: 'background',
            state: 'working',
            description: 'Read notes',
            stoppable: true
          }
        }
      ]
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
