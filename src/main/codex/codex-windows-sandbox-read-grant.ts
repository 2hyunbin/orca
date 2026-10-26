import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { getSystem32ExePath } from '../win32-utils'

// Codex's elevated sandbox runs commands as members of this local group (codex-rs windows-sandbox-rs/src/winutil.rs).
const CODEX_SANDBOX_USERS_GROUP = 'CodexSandboxUsers'
const ICACLS_TIMEOUT_MS = 10_000

const grantedHomes = new Set<string>()

/**
 * Codex's elevated setup grants its sandbox group read on every USERPROFILE child, so ~/.codex is
 * readable; Orca's managed home sits under a protected userData DACL and never gets that ACE.
 */
export async function grantCodexSandboxReadOnManagedHome(codexHome: string): Promise<void> {
  // The setup marker exists only after Codex provisioned elevated-sandbox users for this home.
  if (
    process.platform !== 'win32' ||
    grantedHomes.has(codexHome) ||
    !existsSync(join(codexHome, '.sandbox', 'setup_marker.json'))
  ) {
    return
  }
  try {
    const result = await runProcess({
      program: getSystem32ExePath('icacls.exe'),
      args: [codexHome, '/grant', `${CODEX_SANDBOX_USERS_GROUP}:(OI)(CI)RX`, '/Q'],
      timeoutMs: ICACLS_TIMEOUT_MS
    })
    if (result.code === 0 && !result.timedOut) {
      grantedHomes.add(codexHome)
      return
    }
    console.warn(
      '[codex] sandbox read grant on managed home failed',
      result.stderr || result.stdout
    )
  } catch (error) {
    console.warn('[codex] sandbox read grant on managed home failed', error)
  }
}
