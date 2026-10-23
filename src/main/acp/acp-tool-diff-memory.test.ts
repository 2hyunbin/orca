import { runProcess } from '@orca/process-host'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('preserves a supported newline-heavy ACP diff within a 128 MiB heap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-acp-diff-memory-'))
  try {
    const child = join(root, 'diff.cjs')
    await build({
      stdin: {
        contents: `
          import { createHash } from 'node:crypto';
          import { AcpToolTimeline } from './src/main/acp/acp-tool-timeline';
          import { resolveAcpPeerOptions } from './src/main/acp/acp-peer-limits';
          const update = {
            sessionUpdate: 'tool_call_update', toolCallId: 'call', status: 'completed',
            content: [{ type: 'diff', path: '/repo/generated.txt', oldText: '', newText: 'x\\n'.repeat(3_000_000) }]
          };
          const frame = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session', update } };
          const frameBytes = Buffer.byteLength(JSON.stringify(frame));
          if (frameBytes > resolveAcpPeerOptions().maxLineBytes) throw new Error('Unsupported test frame');
          const events = new AcpToolTimeline().translate(update, {}, {});
          const event = events.find(event => event.type === 'item.update' && event.body.kind === 'diff');
          if (!event) throw new Error('Missing diff');
          const patch = event.body.patch;
          console.log(JSON.stringify({
            byteLength: patch.byteLength, digest: patch.digest, truncated: patch.truncated,
            actualDigest: createHash('sha256').update(patch.head).digest('hex'),
            peakRss: process.resourceUsage().maxRSS * 1024
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
      byteLength: number
      digest: string
      actualDigest: string
      truncated: boolean
      peakRss: number
    } = JSON.parse(result.stdout)
    const digest = 'ca2a9c486a8bc706ece9fe24350f24c985b5bb25c304451a8d28aaa1cd24ed51'
    expect(output).toMatchObject({
      byteLength: 9_000_070,
      digest,
      actualDigest: digest,
      truncated: false
    })
    expect(output.peakRss).toBeLessThan(240 * 1024 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
