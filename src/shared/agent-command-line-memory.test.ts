import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('recognizes a complete startup script within a 64 MiB heap', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-command-line-memory-'))
  try {
    const child = join(directory, 'recognize-command.cjs')
    await build({
      stdin: {
        contents: `
          import { recognizeAgentProcessFromCommandLine } from './src/shared/agent-process-recognition';
          import { tokenizeCommandLine } from './src/shared/agent-command-line-entrypoint';
          import { createHash } from 'node:crypto';
          const command = "cat > generated.txt <<'ORCA_EOF'\\n"
            + ('d'.repeat(400) + '\\n').repeat(20_000) + 'ORCA_EOF\\nprintf done\\n';
          const recognition = recognizeAgentProcessFromCommandLine(command);
          const tokens = tokenizeCommandLine(command);
          console.log(JSON.stringify({ recognition, bytes: Buffer.byteLength(command),
            commandSha256: createHash('sha256').update(command).digest('hex'),
            tokensSha256: createHash('sha256').update(tokens.join('\\0')).digest('hex'),
            count: tokens.length, first: tokens.slice(0, 4), last: tokens.slice(-3) }));
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
      recognition: null,
      bytes: 8_020_054,
      commandSha256: 'b5cd9f054b6fafdfd217eea2a2857486eb256a9a854411dbf15372af1d826436',
      tokensSha256: '2fc3fe90fa09863a341c01ce59c28669c4cd00a40a036619019da308560ad989',
      count: 20_007,
      first: ['cat', '>', 'generated.txt', '<<ORCA_EOF'],
      last: ['ORCA_EOF', 'printf', 'done']
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
