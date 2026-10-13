import { constants, type BigIntStats } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { isPathInsideOrEqual } from './cross-platform-path'

export type AuthorizedRegularFileRequest = {
  boundaryPath: string
  entryPath: string
  implicitRootPath: string | null
  authorizedRootPaths: string[]
  targetPath: string
}

export type AuthorizedRegularFile = {
  handle: FileHandle
  canonicalTarget: string
  canonicalBoundary: string
}

export class AuthorizedFilePathError extends Error {
  constructor() {
    super('file_path_unauthorized')
    this.name = 'AuthorizedFilePathError'
  }
}

export function sameRegularFileIdentity(opened: BigIntStats, current: BigIntStats): boolean {
  return opened.dev === current.dev && opened.ino === current.ino
}

export async function openAuthorizedRegularFile(
  request: AuthorizedRegularFileRequest
): Promise<AuthorizedRegularFile> {
  request = { ...request, authorizedRootPaths: [...request.authorizedRootPaths] }
  const [boundary, entry, target, implicitRoot, roots] = await Promise.all([
    realpath(request.boundaryPath),
    realpath(request.entryPath),
    realpath(request.targetPath),
    request.implicitRootPath === null ? Promise.resolve(null) : realpath(request.implicitRootPath),
    Promise.all(request.authorizedRootPaths.map((root) => realpath(root)))
  ])
  const entryAuthorized = isPathInsideOrEqual(boundary, entry) && target === entry
  const implicitAuthorized =
    implicitRoot !== null &&
    implicitRoot !== boundary &&
    isPathInsideOrEqual(boundary, implicitRoot) &&
    isPathInsideOrEqual(implicitRoot, target)
  const explicitAuthorized = roots.some(
    (root) => isPathInsideOrEqual(boundary, root) && isPathInsideOrEqual(root, target)
  )
  if (
    !isPathInsideOrEqual(boundary, target) ||
    (!entryAuthorized && !implicitAuthorized && !explicitAuthorized)
  ) {
    throw new AuthorizedFilePathError()
  }
  const nofollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  // Nonblocking open lets the regular-file check reject a writer-less FIFO.
  const nonblock = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0
  const handle = await open(target, constants.O_RDONLY | nofollow | nonblock)
  try {
    const [opened, currentTarget, currentBoundary, current] = await Promise.all([
      handle.stat({ bigint: true }),
      realpath(request.targetPath),
      realpath(request.boundaryPath),
      stat(target, { bigint: true })
    ])
    if (
      !opened.isFile() ||
      currentTarget !== target ||
      currentBoundary !== boundary ||
      !sameRegularFileIdentity(opened, current)
    ) {
      throw new AuthorizedFilePathError()
    }
    return { handle, canonicalTarget: target, canonicalBoundary: boundary }
  } catch (error) {
    await handle.close()
    throw error
  }
}
