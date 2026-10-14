import { stat } from 'node:fs/promises'
import type { RuntimeStore } from './runtime-store-contract'

type RestoreHintSource = Pick<RuntimeStore, 'takeOrcadMigrationTerminalRestoreHint'>

/** Non-null `connectionId` is an SSH workspace, whose folders this host's filesystem cannot see. */
type RestoreHintWorkspace = { connectionId?: string | null }

/**
 * The folder a moved pane last used, consumed on its first default-cwd create. An explicit cwd
 * wins and leaves the hint alone; a hint whose folder is gone is dropped, not retried.
 */
export async function takeMigratedPaneRestoreCwd(
  store: RestoreHintSource | null | undefined,
  workspace: RestoreHintWorkspace,
  paneKey: string,
  requestedCwd: string | null | undefined,
  directoryExists: (path: string) => Promise<boolean> = isDirectory
): Promise<string | null> {
  if (requestedCwd?.trim() || workspace.connectionId) {
    return null
  }
  let cwd: string | null
  try {
    cwd = store?.takeOrcadMigrationTerminalRestoreHint?.(paneKey) ?? null
  } catch (error) {
    // A hint store that cannot write must not block opening the terminal.
    console.warn('[terminal-create] restore hint unavailable:', error)
    return null
  }
  if (!cwd) {
    return null
  }
  return (await directoryExists(cwd)) ? cwd : null
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
