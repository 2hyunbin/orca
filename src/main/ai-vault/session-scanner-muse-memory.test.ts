import { runProcess } from '@orca/process-host'
import { createHash } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('reads every Muse message from a 129 MiB transcript within a 64 MiB heap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-muse-memory-'))
  try {
    const path = join(root, 'session.jsonl')
    const text = 'x'.repeat(16 * 1024)
    const prompt = 'Preserve the final prompt 😊'
    const row = `${JSON.stringify({
      record_type: 'event',
      payload_type: 'runtime.session',
      recorded_at: 1780000000000000,
      payload: { kind: 'run', event: { kind: 'assistant_message_committed', text } }
    })}\n`
    const descriptor = openSync(path, 'w')
    const digest = createHash('sha256')
    try {
      const chunk = row.repeat(64)
      for (let index = 0; index < 128; index++) {
        writeSync(descriptor, chunk)
      }
      writeSync(
        descriptor,
        JSON.stringify({
          record_type: 'event',
          payload_type: 'runtime.user_intent.accepted',
          recorded_at: 1780000001000000,
          payload: { refill_blocks: [{ kind: 'text', text: prompt }] }
        })
      )
    } finally {
      closeSync(descriptor)
    }
    for (let index = 0; index < 8192; index++) {
      digest.update(`assistant\0${text}\0`)
    }
    digest.update(`user\0${prompt}\0`)
    const expectedDigest = digest.digest('hex')
    const child = join(root, 'scan.cjs')
    await build({
      stdin: {
        contents: `
          import { createHash } from 'node:crypto';
          import { parseMuseSessionFile } from './src/main/ai-vault/session-scanner-muse-parser';
          const digest = createHash('sha256');
          let count = 0;
          parseMuseSessionFile({
            path: ${JSON.stringify(path)},
            mtimeMs: 1780000001000,
            modifiedAt: '2026-05-28T20:26:41.000Z'
          }, 'linux', {
            active: true,
            push: message => { count++; digest.update(message.role + '\\0' + message.text + '\\0'); }
          }).then(session => console.log(JSON.stringify({
            count, digest: digest.digest('hex'),
            messageCount: session?.messageCount, title: session?.title,
            rss: process.memoryUsage().rss
          })));
        `,
        resolveDir: process.cwd()
      },
      outfile: child,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
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
    const output: {
      count: number
      digest: string
      messageCount: number
      title: string
      rss: number
    } = JSON.parse(result.stdout)
    expect(output).toMatchObject({
      count: 8193,
      digest: expectedDigest,
      messageCount: 8193,
      title: prompt
    })
    expect(output.rss).toBeLessThan(160 * 1024 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
