import { createBrowserUuid } from '@/lib/browser-uuid'

// Why a token, not a path: a browser File has no path, yet the composer's attach flow is path
// based. The token keeps the file's name last, so chips and notices still read `basename(path)`.
const TOKEN_PREFIX = 'orca-browser-file:'

// Bounds files a refused attach (a terminal chat, a busy composer) leaves unclaimed.
const MAX_HELD_FILES = 256

const heldFiles = new Map<string, File>()

/** Holds files a browser picker or drop produced until an upload claims them by token. */
export function holdBrowserAttachmentFiles(files: readonly File[]): string[] {
  return files.map((file) => {
    const token = `${TOKEN_PREFIX}${createBrowserUuid()}/${file.name}`
    heldFiles.set(token, file)
    for (const oldest of heldFiles.keys()) {
      if (heldFiles.size <= MAX_HELD_FILES) {
        break
      }
      heldFiles.delete(oldest)
    }
    return token
  })
}

/** The held file for `token`, released so it can be claimed once. */
export function takeBrowserAttachmentFile(token: string): File | null {
  const file = heldFiles.get(token) ?? null
  heldFiles.delete(token)
  return file
}
