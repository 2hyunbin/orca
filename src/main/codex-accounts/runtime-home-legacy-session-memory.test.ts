import { runProcess } from '@orca/process-host'
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('recognizes an already migrated 256 MiB session without loading both copies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-legacy-session-memory-'))
  try {
    const legacy = join(root, 'legacy')
    const runtime = join(root, 'runtime')
    mkdirSync(join(legacy, 'sessions'), { recursive: true })
    mkdirSync(join(runtime, 'sessions'), { recursive: true })
    const source = join(legacy, 'sessions', 'rollout.jsonl')
    const target = join(runtime, 'sessions', 'rollout.jsonl')
    const fd = openSync(source, 'w')
    try {
      const line = `${JSON.stringify({
        timestamp: '2026-10-23T00:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'x'.repeat(1024 * 1024) }
      })}\n`
      for (let index = 0; index < 256; index++) {
        writeFileSync(fd, line)
      }
    } finally {
      closeSync(fd)
    }
    copyFileSync(source, target)
    const child = join(root, 'migrate.cjs')
    await build({
      stdin: {
        contents: `
          import { existsSync, statSync } from 'node:fs';
          import { CodexRuntimeHomeLegacyMigration } from './src/main/codex-accounts/runtime-home-service-legacy-migration';
          class Home extends CodexRuntimeHomeLegacyMigration {
            getRuntimeHomePath() { return ${JSON.stringify(runtime)}; }
            getMigrationDiagnosticsPath() { return ${JSON.stringify(join(root, 'diagnostics.jsonl'))}; }
          }
          new Home({}).migrateLegacySessions(${JSON.stringify(legacy)}, 'account-1');
          console.log(JSON.stringify({
            bytes: statSync(${JSON.stringify(target)}).size,
            preserved: existsSync(${JSON.stringify(join(runtime, 'sessions', 'rollout.orca-legacy-account-1.jsonl'))}),
            diagnostics: existsSync(${JSON.stringify(join(root, 'diagnostics.jsonl'))}),
            rss: process.memoryUsage().rss
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
      args: [child],
      env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 15_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    const output: { bytes: number; preserved: boolean; diagnostics: boolean; rss: number } =
      JSON.parse(result.stdout)
    expect(output).toMatchObject({ preserved: false, diagnostics: false })
    expect(output.bytes).toBeGreaterThan(256 * 1024 * 1024)
    expect(output.rss).toBeLessThan(192 * 1024 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
