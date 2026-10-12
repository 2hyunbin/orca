import { renameSync, rmSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { isPermissionError } from '../win32-utils'

// Why: Windows refuses to replace a running executable but lets it be renamed. With an aside
// path, a locked target is moved there and the new file takes its name (the next install
// deletes the aside); without one, or if the aside is itself still running, the rename throws.
export function renameOverLockedTarget(
  tmpPath: string,
  targetPath: string,
  asidePath: string | undefined
): void {
  try {
    renameSync(tmpPath, targetPath)
  } catch (error) {
    if (asidePath === undefined || !isPermissionError(error)) {
      throw error
    }
    rmSync(asidePath, { force: true })
    renameSync(targetPath, asidePath)
    renameSync(tmpPath, targetPath)
  }
}

export async function renameOverLockedTargetAsync(
  tmpPath: string,
  targetPath: string,
  asidePath: string | undefined
): Promise<void> {
  try {
    await rename(tmpPath, targetPath)
  } catch (error) {
    if (asidePath === undefined || !isPermissionError(error)) {
      throw error
    }
    await rm(asidePath, { force: true })
    await rename(targetPath, asidePath)
    await rename(tmpPath, targetPath)
  }
}
