import { openSync, closeSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { isValidAppVersion } from '../../shared/app-version'
import { ORCAD_VERSION_FILENAME } from '../../shared/orcad-artifacts'

export function resolveOrcadBuildVersion(
  directory: string,
  environment: NodeJS.ProcessEnv = process.env
): string {
  let handle: number
  try {
    handle = openSync(join(directory, ORCAD_VERSION_FILENAME), 'r')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
    const fallback = environment.ORCA_VERSION || '0.0.0-orcad'
    if (!isValidAppVersion(fallback)) {
      throw new Error('The standalone Orca build version is invalid')
    }
    return fallback
  }
  try {
    const bytes = Buffer.alloc(257)
    const size = readSync(handle, bytes, 0, bytes.length, null)
    const version = bytes.subarray(0, size).toString('utf8').trim()
    if (size > 256 || !isValidAppVersion(version)) {
      throw new Error('The standalone Orca version marker is invalid')
    }
    return version
  } finally {
    closeSync(handle)
  }
}
