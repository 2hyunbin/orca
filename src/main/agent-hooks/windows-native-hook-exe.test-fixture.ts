import { runProcessSync } from '@orca/process-host'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')

// Why the real build: the Windows hook suites must exercise the binary the package ships,
// and the build script's fingerprint makes every suite after the first reuse it.
export function buildWindowsNativeHookExecutable(): string {
  const result = runProcessSync({
    program: process.execPath,
    args: [join(REPO_ROOT, 'config', 'scripts', 'build-windows-agent-hook.mjs')],
    cwd: REPO_ROOT,
    timeoutMs: 300_000
  })
  if (result.code !== 0) {
    throw new Error(`orca-hook.exe build failed:\n${result.stdout}\n${result.stderr}`)
  }
  return join(REPO_ROOT, 'native', 'windows-agent-hook', '.build', 'orca-hook.exe')
}

// A cold cargo build links from scratch, far past Vitest's default hook budget.
export const WINDOWS_NATIVE_HOOK_BUILD_TIMEOUT_MS = 300_000
