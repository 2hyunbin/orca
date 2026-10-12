import { runProcessSync } from '@orca/process-host'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '../../..')

let suiteCopy: string | null = null

/**
 * The real orca-hook.exe, as a copy private to this test file.
 * Why the real build: the Windows hook suites must exercise the binary the package ships, and
 * the build script's fingerprint makes every suite after the first reuse it. Why a private copy:
 * the CI lane runs these files in parallel, so the shared build output is rewritten while other
 * suites read, install or start it.
 */
export function buildWindowsNativeHookExecutable(): string {
  if (suiteCopy) {
    return suiteCopy
  }
  const result = runProcessSync({
    program: process.execPath,
    args: [join(REPO_ROOT, 'config', 'scripts', 'build-windows-agent-hook.mjs')],
    cwd: REPO_ROOT,
    timeoutMs: 300_000
  })
  if (result.code !== 0) {
    throw new Error(`orca-hook.exe build failed:\n${result.stdout}\n${result.stderr}`)
  }
  const dir = mkdtempSync(join(tmpdir(), 'orca-hook-build-'))
  const copy = join(dir, 'orca-hook.exe')
  copyFileSync(join(REPO_ROOT, 'native', 'windows-agent-hook', '.build', 'orca-hook.exe'), copy)
  process.once('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A copy still mapped by an exiting hook stays in TEMP; it is never reused.
    }
  })
  suiteCopy = copy
  return copy
}

// A cold cargo build links from scratch, far past Vitest's default hook budget.
export const WINDOWS_NATIVE_HOOK_BUILD_TIMEOUT_MS = 300_000
