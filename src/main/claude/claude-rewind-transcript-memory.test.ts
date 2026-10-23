import { runProcess } from '@orca/process-host'
import { randomUUID } from 'node:crypto'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

it('materializes a 32 MiB rewind transcript within a 96 MiB heap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-rewind-memory-'))
  try {
    const source = randomUUID()
    const sourcePath = join(root, `${source}.jsonl`)
    let previous: string | null = null
    const file = await open(sourcePath, 'wx', 0o600)
    try {
      for (let index = 0; index < 128; index++) {
        const uuid = randomUUID()
        const role = index === 0 ? 'user' : 'assistant'
        await file.writeFile(
          `${JSON.stringify({
            type: role,
            uuid,
            parentUuid: previous,
            sessionId: source,
            timestamp: '2026-10-20T00:00:00.000Z',
            isSidechain: false,
            message: { role, content: [{ type: 'text', text: 'x'.repeat(256 * 1024) }] }
          })}\n`
        )
        previous = uuid
      }
    } finally {
      await file.close()
    }
    const moduleUrl = pathToFileURL(
      join(process.cwd(), 'src/main/claude/claude-rewind-transcript.ts')
    ).href
    const program = `
      import { stat } from 'node:fs/promises';
      import { join } from 'node:path';
      const { materializeClaudeRewindTranscript } = await import(${JSON.stringify(moduleUrl)});
      const result = await materializeClaudeRewindTranscript(${JSON.stringify(sourcePath)}, {
        sessionId: ${JSON.stringify(randomUUID())},
        sourceSessionId: ${JSON.stringify(source)},
        throughEntryId: ${JSON.stringify(previous)},
        replacesSessionId: ${JSON.stringify(source)}
      });
      const output = await stat(join(${JSON.stringify(root)}, result.sessionId + '.jsonl'));
      console.log(JSON.stringify({
        materialized: result.materialized,
        resumeCursor: !!result.resumeCursor,
        bytes: output.size
      }));
    `
    const result = await runProcess({
      program: process.execPath,
      args: [
        '--max-old-space-size=96',
        '--import',
        createRequire(import.meta.url).resolve('tsx'),
        '--input-type=module',
        '-e',
        program
      ],
      env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 15_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      materialized: true,
      resumeCursor: true,
      bytes: expect.any(Number)
    })
    const output: { bytes: number } = JSON.parse(result.stdout)
    expect(output.bytes).toBeGreaterThan(32 * 1024 * 1024)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
