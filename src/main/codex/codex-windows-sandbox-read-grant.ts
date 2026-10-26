import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { getSystem32ExePath } from '../win32-utils'

// Codex's elevated sandbox runs commands as members of this local group (codex-rs windows-sandbox-rs/src/winutil.rs).
const CODEX_SANDBOX_USERS_GROUP = 'CodexSandboxUsers'
// icacls propagates the inheritable ACE to every existing file; large homes take a while.
const ICACLS_TIMEOUT_MS = 120_000

// One attempt per home per process, shared by concurrent launches; failures retry after restart.
const grantAttempts = new Map<string, Promise<void>>()

/**
 * Codex's elevated setup grants its sandbox group read on every USERPROFILE child, so ~/.codex is
 * readable; Orca's managed home sits under a protected userData DACL and never gets that ACE.
 */
export function grantCodexSandboxReadOnManagedHome(codexHome: string): Promise<void> {
  // The setup marker exists only after Codex provisioned elevated-sandbox users for this home.
  if (
    process.platform !== 'win32' ||
    !existsSync(join(codexHome, '.sandbox', 'setup_marker.json'))
  ) {
    return Promise.resolve()
  }
  let attempt = grantAttempts.get(codexHome)
  if (!attempt) {
    attempt = runIcaclsGrant(codexHome)
    grantAttempts.set(codexHome, attempt)
  }
  return attempt
}

async function runIcaclsGrant(codexHome: string): Promise<void> {
  try {
    const result = await runProcess({
      program: getSystem32ExePath('icacls.exe'),
      args: [codexHome, '/grant', `${CODEX_SANDBOX_USERS_GROUP}:(OI)(CI)RX`, '/Q'],
      timeoutMs: ICACLS_TIMEOUT_MS
    })
    if (result.code !== 0 || result.timedOut) {
      console.warn(
        '[codex] sandbox read grant on managed home failed',
        result.stderr || result.stdout
      )
    }
  } catch (error) {
    console.warn('[codex] sandbox read grant on managed home failed', error)
  }
}
