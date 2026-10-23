import { runProcess } from '@orca/process-host'
import { createHash } from 'node:crypto'
import {
  closeSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('links and refreshes a large shared prompt history within a 48 MiB heap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-profile-history-memory-'))
  try {
    const userHome = join(root, 'user')
    const history = join(userHome, '.claude', 'history.jsonl')
    mkdirSync(join(userHome, '.claude'), { recursive: true })
    const digest = createHash('sha256')
    const padding = 'x'.repeat(950)
    const descriptor = openSync(history, 'w')
    try {
      for (let index = 0; index < 64; index++) {
        const chunk = `${Array.from({ length: 1024 }, (_, row) => {
          const timestamp = index * 1024 + row
          return JSON.stringify({
            display: `${timestamp}:${padding}`,
            timestamp,
            project: '/workspace'
          })
        }).join('\n')}\n`
        writeSync(descriptor, chunk)
        digest.update(chunk)
      }
    } finally {
      closeSync(descriptor)
    }
    const expectedDigest = digest.digest('hex')
    const child = join(root, 'refresh.cjs')
    await build({
      stdin: {
        contents: `
          import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
          import { join } from 'node:path';
          import { shareClaudeProfileHistory } from './src/main/claude-accounts/claude-profile-history';
          (async () => {
            const results = [];
            const userHome = ${JSON.stringify(userHome)};
            for (const platform of process.platform === 'win32' ? ['win32'] : ['linux', 'win32']) {
              const profileHome = join(${JSON.stringify(root)}, platform);
              mkdirSync(profileHome);
              const share = () => shareClaudeProfileHistory({ profileHome, userHome, platform });
              const first = await share();
              const pending = join(profileHome, 'history.jsonl.orca-profile-merge');
              writeFileSync(pending, 'already drained\\n');
              writeFileSync(pending + '.offset', '16\\n');
              const second = await share();
              const own = statSync(join(profileHome, 'history.jsonl'), { bigint: true });
              const shared = statSync(${JSON.stringify(history)}, { bigint: true });
              results.push({
                outcomes: [first.surfaces['history.jsonl'], second.surfaces['history.jsonl']],
                warnings: [...first.warnings, ...second.warnings],
                linked: own.dev === shared.dev && own.ino === shared.ino,
                pending: existsSync(pending) || existsSync(pending + '.offset')
              });
            }
            console.log(JSON.stringify(results));
          })();
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
      args: ['--max-old-space-size=48', child],
      env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 15_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    const expected = {
      outcomes: ['linked', 'unchanged'],
      warnings: [],
      linked: true,
      pending: false
    }
    expect(JSON.parse(result.stdout)).toEqual(
      process.platform === 'win32' ? [expected] : [expected, expected]
    )
    const actualDigest = createHash('sha256')
    for await (const bytes of createReadStream(history)) {
      actualDigest.update(bytes)
    }
    expect(actualDigest.digest('hex')).toBe(expectedDigest)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
