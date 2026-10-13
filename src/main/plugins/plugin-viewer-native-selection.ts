import type { WebContents } from 'electron'

export function copyPluginViewerGuestSelection(
  guest: WebContents,
  owner: { lastCopyAt?: number }
): boolean {
  const now = Date.now()
  if (owner.lastCopyAt !== undefined && now - owner.lastCopyAt < 250) {
    return false
  }
  owner.lastCopyAt = now
  try {
    // Author code never receives clipboard authority or contents.
    guest.copy()
    return true
  } catch {
    return false
  }
}
