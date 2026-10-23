import { runProcess } from '@orca/process-host'
import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('accepts a repeated 256 MiB profile export without retaining both complete files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-export-memory-'))
  try {
    const source = join(root, 'source.json')
    const fd = openSync(source, 'w')
    try {
      writeFileSync(fd, '{"unknown":"')
      const chunk = Buffer.alloc(64 * 1024, 0x78)
      for (let index = 0; index < 4096; index++) {
        writeFileSync(fd, chunk)
      }
      writeFileSync(fd, '"}')
    } finally {
      closeSync(fd)
    }
    const child = join(root, 'export.cjs')
    await build({
      stdin: {
        contents: `
          import { copyFileSync, statSync } from 'node:fs';
          import { writeVersionedProfileStateExport } from './src/main/persistence/profile-state/legacy-json/profile-state-versioned-export';
          import { profileStateJsonExportPath } from './src/main/persistence/profile-state/legacy-json/profile-state-export-path';
          const [source, target] = process.argv.slice(2);
          const write = () => writeVersionedProfileStateExport(target, (staging) => {
            copyFileSync(source, staging);
            return 4;
          });
          const first = write();
          const repeated = write();
          console.log(JSON.stringify({
            first,
            repeated,
            bytes: statSync(profileStateJsonExportPath(target, 4)).size,
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
      args: [child, source, join(root, 'orca-data.json')],
      env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 15_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    const output: { first: number; repeated: number; bytes: number; rss: number } = JSON.parse(
      result.stdout
    )
    expect(output).toMatchObject({ first: 4, repeated: 4, bytes: statSync(source).size })
    expect(output.rss).toBeLessThan(192 * 1024 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
