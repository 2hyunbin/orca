import { constants, open } from 'node:fs/promises'
import { assertLocalTerminalArtifactPathStillCanonical } from './local-artifact-read'
import { localTerminalArtifactContentDigest } from './artifact-integrity'
import type { RuntimeFileStatLike } from './file-grants'

/** Stat and content digest come from one handle to retain the existing swap protection. */
export async function statLocalTerminalArtifact(absolutePath: string): Promise<{
  stats: RuntimeFileStatLike & { isDirectory: () => boolean; isFile: () => boolean }
  contentDigest: string | null
}> {
  await assertLocalTerminalArtifactPathStillCanonical(absolutePath)
  // Why non-blocking: opening a named pipe for reading waits for a writer; its type is refused below.
  const handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    const stats = await handle.stat()
    const contentDigest = stats.isFile()
      ? await localTerminalArtifactContentDigest(handle, stats.size)
      : null
    return { stats, contentDigest }
  } finally {
    await handle.close()
  }
}
