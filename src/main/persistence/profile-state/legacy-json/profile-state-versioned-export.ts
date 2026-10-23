import { lstatSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { nodeFilesEqualSync } from '../../../../shared/node-file-content-equality'
import { bestEffortFsyncDirectorySync, fsyncFileSync } from '../../../../shared/secure-file'
import { durableWriteTempPath, publishFileDurableSync } from '../../../durable-file-write'
import {
  profileStateJsonExportPath,
  profileStateJsonExportPaths
} from './profile-state-export-path'

/** An existing revision must never be replaced with different content. */
export function writeVersionedProfileStateExport(
  dataFile: string,
  writeExport: (targetPath: string) => number,
  options: { retainAllExports?: boolean } = {}
): number | undefined {
  const stagingPath = durableWriteTempPath(`${dataFile}.sqlite-export.pending`)
  try {
    const revision = writeExport(stagingPath)
    if (revision === 0) {
      return undefined
    }
    const targetPath = profileStateJsonExportPath(dataFile, revision)
    mkdirSync(dirname(targetPath), { recursive: true })
    if (!publishFileDurableSync(stagingPath, targetPath)) {
      if (!nodeFilesEqualSync(stagingPath, targetPath)) {
        throw new Error(
          `Profile state export revision ${revision} already exists with different content`
        )
      }
      fsyncFileSync(targetPath)
      bestEffortFsyncDirectorySync(dirname(targetPath))
    }
    if (!options.retainAllExports) {
      pruneProfileStateJsonExports(dataFile)
    }
    return revision
  } finally {
    rmSync(stagingPath, { force: true })
  }
}

function pruneProfileStateJsonExports(dataFile: string): void {
  try {
    const regularExports = profileStateJsonExportPaths(dataFile).filter((path) =>
      lstatSync(path).isFile()
    )
    for (const path of regularExports.slice(5)) {
      rmSync(path, { force: true })
    }
  } catch (error) {
    console.warn('[persistence] Failed to prune retained JSON exports:', error)
  }
}
