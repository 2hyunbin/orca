import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('summarizes 500 stored tasks within a 128 MiB heap without changing their specs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-task-brief-memory-'))
  try {
    const child = join(directory, 'task-brief.cjs')
    await build({
      stdin: {
        contents: `
          import { OrchestrationDb } from './src/main/runtime/orchestration/db';
          import { abbreviateOrchestrationTasks } from './src/shared/orchestration-task-summary';
          import { TaskCreateParams } from './src/shared/rpc-contract/orchestration-params';
          import { createHash } from 'node:crypto';
          const db = new OrchestrationDb(':memory:');
          const run = db.createRun({ objective: 'Task summary', coordinatorHandle: null, coordinatorPaneKey: null });
          const spec = 'Task details ' + 'row '.repeat(24_000);
          TaskCreateParams.parse({ spec });
          if (Buffer.byteLength(JSON.stringify({ method: 'orchestration.taskCreate', params: { spec } })) > 1024 * 1024) throw new Error('Unsupported RPC request');
          if (Buffer.byteLength(spec) > 128 * 1024) throw new Error('Spec exceeds CLI argument limit');
          for (let index = 0; index < 500; index++) {
            db.createTask({ runId: run.id, spec, taskTitle: 'Task ' + index, displayName: 'Task ' + index });
          }
          global.gc();
          const rows = db.listTasksWithDispatch({ runId: run.id });
          const result = abbreviateOrchestrationTasks(rows);
          const original = createHash('sha256');
          for (const row of rows) original.update(row.spec);
          console.log(JSON.stringify({
            count: result.length,
            idsPreserved: result.every((row, index) => row.id === rows[index].id),
            specsUnchanged: rows.every(row => row.spec === spec),
            sourceSha256: original.digest('hex'),
            briefSha256: createHash('sha256').update(JSON.stringify(result.map(row => [row.spec, row.spec_truncated]))).digest('hex')
          }));
          db.close();
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
      args: ['--expose-gc', '--max-old-space-size=128', child],
      env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 20_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      count: 500,
      idsPreserved: true,
      specsUnchanged: true,
      sourceSha256: '54e83fe710082de66041c35d6ae77e93b200881ac9b89b6bf1697d2a49575e82',
      briefSha256: '16c061d51fa44463ed1d7fe0a9217b6d61a9bfb7eac73fb3ebbce104ab668505'
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
