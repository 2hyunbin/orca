import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { grantDirAclAsync } from '../win32-utils'
import { loadWindowsSecurityAddon } from '../../shared/windows-security-addon'

/**
 * Startup ACL grant for the win32 userData tree.
 *
 * Why this exists (PR #1152): Chromium's BrowserWindow constructor resets the
 * userData DACL to a Protected DACL whose propagated child ACEs carry the
 * Inherit-Only flag, so file writes inside pre-existing subdirectories
 * (codex-runtime-home, agent-hooks, …) fail with EPERM. Explicit ACEs survive
 * future DACL propagation, so granting them once fixes the tree permanently.
 *
 * Why not a recursive per-file walk: NTFS inheritance is recalculated from the
 * immediate parent, so explicit ACEs on userData + its immediate child
 * directories already protect the whole tree. On a real 28k-file profile a
 * recursive walk measured 62s.
 *
 * Strategy:
 * - A marker file records that the grant completed for this identity. When it
 *   matches, startup touches no ACL at all.
 * - When absent, the grant runs on the thread pool (never blocks window
 *   creation): each immediate child directory, then the root. Per-write EPERM
 *   retries in codex-accounts/fs-utils and agent-hooks/installer-utils remain
 *   the backstop during that window.
 */

export const WINDOWS_ACL_GRANT_MARKER_FILE = 'windows-acl-grant.json'
export const WINDOWS_ACL_GRANT_SCHEME_VERSION = 1

type WindowsAclGrantMarker = {
  schemeVersion: number
  identity: string
  grantedAt: number
}

export type WindowsAclGrantResult =
  | { mode: 'marker-hit' }
  | { mode: 'granted' }
  | { mode: 'failed'; reason: string }
  | { mode: 'no-identity' }

type EnsureOptions = {
  onDone?: (result: WindowsAclGrantResult) => void
  /** Test seam — defaults to the native current-user grant. */
  grantFn?: (directory: string) => Promise<void>
  /** Test seam — defaults to the current user's SID. */
  identity?: string | null
  /** Test seam — the pre-native identity a marker may still record. */
  legacyIdentity?: string
}

function readMarker(userDataPath: string): WindowsAclGrantMarker | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(userDataPath, WINDOWS_ACL_GRANT_MARKER_FILE), 'utf-8')
    ) as Partial<WindowsAclGrantMarker>
    if (
      parsed.schemeVersion === WINDOWS_ACL_GRANT_SCHEME_VERSION &&
      typeof parsed.identity === 'string'
    ) {
      return parsed as WindowsAclGrantMarker
    }
  } catch {
    // missing or corrupt → re-grant
  }
  return null
}

function writeMarker(userDataPath: string, identity: string): void {
  const marker: WindowsAclGrantMarker = {
    schemeVersion: WINDOWS_ACL_GRANT_SCHEME_VERSION,
    identity,
    grantedAt: Date.now()
  }
  writeFileSync(join(userDataPath, WINDOWS_ACL_GRANT_MARKER_FILE), JSON.stringify(marker))
}

function currentIdentity(): string | null {
  const addon = loadWindowsSecurityAddon()
  if (!addon) {
    return null
  }
  try {
    return `*${addon.currentUserSid()}`
  } catch {
    return null
  }
}

function childDirectories(userDataPath: string): string[] {
  return readdirSync(userDataPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(userDataPath, entry.name))
}

async function grantEach(
  grantFn: (directory: string) => Promise<void>,
  directories: string[]
): Promise<string[]> {
  const failures: string[] = []
  // Sequential: each grant already walks its subtree on a pool thread.
  for (const directory of directories) {
    try {
      await grantFn(directory)
    } catch (error) {
      // A partial grant is still strictly better than none; the per-write EPERM backstop covers stragglers.
      failures.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return failures
}

/**
 * Ensure the userData tree carries explicit Full Control ACEs for the current
 * user. Returns immediately; the grant itself (first launch only) runs in the
 * background. Call before BrowserWindow creation on win32.
 */
export function ensureWindowsUserDataAclGrant(
  userDataPath: string,
  options: EnsureOptions = {}
): void {
  const onDone = options.onDone ?? ((): void => undefined)
  const identity = options.identity !== undefined ? options.identity : currentIdentity()
  if (!identity) {
    onDone({ mode: 'no-identity' })
    return
  }
  const marker = readMarker(userDataPath)
  // Why the legacy name too: markers written before the native grant record USERNAME, and
  // re-granting would re-walk the whole tree once for nothing.
  const legacyIdentity = options.legacyIdentity ?? process.env.USERNAME
  if (marker && (marker.identity === identity || marker.identity === legacyIdentity)) {
    onDone({ mode: 'marker-hit' })
    return
  }
  const grantFn = options.grantFn ?? grantDirAclAsync
  void (async () => {
    // Immediate children first: those explicit ACEs are the durable fix
    // (Chromium replaces the root DACL on every BrowserWindow construction,
    // but never strips explicit ACEs from children). Root second so writes
    // directly under userData succeed before Chromium's first reset.
    let failures: string[]
    try {
      failures = await grantEach(grantFn, [...childDirectories(userDataPath), userDataPath])
    } catch (error) {
      failures = [error instanceof Error ? error.message : String(error)]
    }
    if (failures.length === 0) {
      try {
        writeMarker(userDataPath, identity)
        onDone({ mode: 'granted' })
      } catch (error) {
        onDone({ mode: 'failed', reason: `marker write: ${String(error)}` })
      }
      return
    }
    onDone({ mode: 'failed', reason: failures.join('; ') })
  })()
}
