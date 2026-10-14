import { resolve } from 'node:path'
import { spawnProcess } from '@orca/process-host'

export function startDevStorageReclaim({
  repoRoot,
  env = process.env,
  spawn = spawnProcess,
  report = console.error
}) {
  if (env.ORCA_SKIP_DEV_STORAGE_RECLAIM === '1') {
    return
  }
  try {
    // The worker owns its cleanup lock even if the dev app exits before it finishes.
    const child = spawn({
      program: process.execPath,
      args: [
        resolve(import.meta.dirname, 'reclaim-worktree-space.mjs'),
        '--repo',
        repoRoot,
        '--exclude-worktree',
        repoRoot,
        '--automatic',
        '--apply'
      ],
      cwd: repoRoot,
      env,
      detached: true,
      stdio: ['ignore', 'inherit', 'inherit']
    })
    child.on('error', (error) => report(`[orca-dev] Storage cleanup skipped: ${error.message}`))
    child.on('exit', (code) => {
      if (code !== 0) {
        report('[orca-dev] Storage cleanup did not finish; retry with pnpm reclaim.')
      }
    })
    child.unref()
  } catch (error) {
    report(`[orca-dev] Storage cleanup skipped: ${error.message}`)
  }
}
