import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { openAuthorizedRegularFile } from '../../shared/authorized-regular-file'
import { readNodeFileHandleWithinLimit } from '../../shared/node-bounded-file-reader'

export const PLUGIN_WORKER_ENTRY_MAX_BYTES = 50 * 1024 * 1024

export async function resolveContainedPluginArtifact(
  rootDir: string,
  relativePath: string,
  maxBytes = PLUGIN_WORKER_ENTRY_MAX_BYTES
): Promise<string> {
  const rootReal = await realpath(resolve(rootDir))
  return resolvePluginArtifactFromRealRoot(rootDir, rootReal, relativePath, 'file', maxBytes)
}

export async function readContainedPluginArtifactText(
  rootDir: string,
  relativePath: string,
  maxBytes: number
): Promise<string> {
  const artifact = await resolveContainedPluginArtifact(rootDir, relativePath, maxBytes)
  const { handle } = await openAuthorizedRegularFile({
    boundaryPath: rootDir,
    entryPath: artifact,
    targetPath: artifact,
    implicitRootPath: null,
    authorizedRootPaths: []
  })
  try {
    const initial = await handle.stat({ bigint: true })
    const { buffer } = await readNodeFileHandleWithinLimit(handle, maxBytes, {
      regularFileOnly: true
    })
    const current = await handle.stat({ bigint: true })
    if (
      initial.size !== current.size ||
      initial.mtimeNs !== current.mtimeNs ||
      initial.ctimeNs !== current.ctimeNs
    ) {
      throw new Error('artifact changed during its read')
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
  } finally {
    await handle.close()
  }
}

export async function resolvePluginArtifactFromRealRoot(
  rootDir: string,
  rootReal: string,
  relativePath: string,
  kind: 'file' | 'directory',
  maxBytes?: number
): Promise<string> {
  const artifactReal = await realpath(resolve(rootDir, ...relativePath.split(/[\\/]/)))
  const fromRoot = relative(rootReal, artifactReal)
  if (
    fromRoot.length === 0 ||
    isAbsolute(fromRoot) ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`)
  ) {
    throw new Error('resolves outside the plugin directory')
  }
  const artifactStat = await stat(artifactReal)
  if (kind === 'file' && !artifactStat.isFile()) {
    throw new Error('is not a regular file')
  }
  if (kind === 'directory' && !artifactStat.isDirectory()) {
    throw new Error('is not a directory')
  }
  if (kind === 'file' && maxBytes !== undefined && artifactStat.size > maxBytes) {
    throw new Error(`exceeds the ${maxBytes}-byte artifact limit`)
  }
  return artifactReal
}
