import { resolve } from 'node:path'
import { spawnProcess } from '@orca/process-host'

export function startDevStorageMaintenance(
  repoRoot,
  { env = process.env, platform = process.platform, spawn = spawnProcess } = {}
) {
  if (
    platform !== 'darwin' ||
    env.ORCA_DISABLE_STORAGE_MAINTENANCE === '1' ||
    env.CI ||
    env.VITEST ||
    env.ORCA_ELECTRON_VITE_CLI
  ) {
    return
  }
  try {
    const child = spawn({
      program: process.execPath,
      args: [
        resolve(import.meta.dirname, 'reclaim-worktree-space.mjs'),
        '--repo',
        repoRoot,
        '--apply',
        '--automatic'
      ],
      env,
      detached: true,
      stdio: 'ignore'
    })
    child.on('error', () => {})
    child.unref()
  } catch {
    // Optional maintenance must never prevent development startup.
  }
}
