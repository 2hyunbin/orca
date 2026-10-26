import { lstat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'

/** Git owns these locks; a process snapshot cannot authorize unlinking their current generation. */
export async function isRepoMaintenanceLocked(commonDir: string): Promise<boolean> {
  const paths = isWindowsAbsolutePathLike(commonDir) ? win32 : posix
  try {
    await lstat(paths.join(commonDir, 'objects', 'maintenance.lock'))
    return true
  } catch (error) {
    // Unknown filesystem state must not admit a writer.
    return !(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
  }
}
