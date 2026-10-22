import { rm } from 'node:fs/promises'

const MAX_WAITING_DIRECTORIES = 2048
const waiting = new Set<string>()
let active: string | undefined

/** Only unpublished directories, after their writer and descriptors have settled. */
export function cleanupFailedDragCopy(directory: string): void {
  if (directory === active || waiting.has(directory)) {
    return
  }
  if (waiting.size >= MAX_WAITING_DIRECTORIES) {
    console.warn('[drop] abandoning failed-copy cleanup: backlog full', { directory })
    return
  }
  waiting.add(directory)
  advance()
}

function advance(): void {
  if (active !== undefined) {
    return
  }
  const directory = waiting.values().next().value
  if (directory === undefined) {
    return
  }
  waiting.delete(directory)
  active = directory
  void remove(directory)
}

async function remove(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true })
  } catch (error) {
    console.warn('[drop] failed-copy cleanup failed', { directory, error })
  } finally {
    active = undefined
    advance()
  }
}
