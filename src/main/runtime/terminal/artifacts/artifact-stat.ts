import { constants, open } from 'node:fs/promises'
import { assertLocalTerminalArtifactPathStillCanonical, OPEN_NONBLOCK } from './local-artifact-read'
import { localTerminalArtifactContentDigest } from './artifact-integrity'
import type { RuntimeFileStatLike } from './file-grants'

/** Stat and content digest come from one handle to retain the existing swap protection. */
export async function statLocalTerminalArtifact(absolutePath: string): Promise<{
  stats: RuntimeFileStatLike & { isDirectory: () => boolean }
  contentDigest: string | null
}> {
  await assertLocalTerminalArtifactPathStillCanonical(absolutePath)
  const handle = await open(absolutePath, constants.O_RDONLY | OPEN_NONBLOCK)
  try {
    const stats = await handle.stat()
    if (!stats.isDirectory() && !stats.isFile()) {
      throw new Error('Only regular files and folders can be opened')
    }
    const contentDigest = stats.isDirectory()
      ? null
      : await localTerminalArtifactContentDigest(handle, stats.size)
    return { stats, contentDigest }
  } finally {
    await handle.close()
  }
}
