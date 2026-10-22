import { createHash, randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { renameFileWithWindowsRetryAsync } from '../../shared/windows-retry-file-operations'
import {
  ensureOwnedTempStagingRoot,
  getOwnedTempStagingRoot
} from '../window/owned-temp-staging-root'

export function agentSessionContextSnapshotRoot(stateDirectory: string): string {
  const profile = createHash('sha256').update(resolve(stateDirectory)).digest('hex').slice(0, 16)
  return getOwnedTempStagingRoot(tmpdir(), `orca-handoff-${profile}`)
}

/** One snapshot per chat, replaced on each hand-off; the OS owns temp retention. */
export async function writeAgentSessionContextSnapshot(
  stateDirectory: string,
  sessionId: string,
  text: string
): Promise<string> {
  const root = agentSessionContextSnapshotRoot(stateDirectory)
  if (!(await ensureOwnedTempStagingRoot(root))) {
    throw new Error('Chat context snapshot folder is not private')
  }
  const name = createHash('sha256').update(sessionId).digest('hex')
  const path = join(root, `${name}.txt`)
  const temporary = `${path}.${randomUUID()}.part`
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 })
    await renameFileWithWindowsRetryAsync(temporary, path)
    return path
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}
