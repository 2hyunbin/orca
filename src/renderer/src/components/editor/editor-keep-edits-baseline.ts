/**
 * Keep My Edits clears the banner at once but learns the disk version it consented to over an
 * async read. A save in that window waits for the read, so it is compared against that version
 * rather than the one the banner was about.
 */
const pendingBaselineReads = new Map<string, Promise<unknown>>()

export function trackKeepEditsBaselineRead(fileId: string, read: Promise<unknown>): void {
  const settled = read.catch(() => undefined)
  pendingBaselineReads.set(fileId, settled)
  void settled.then(() => {
    if (pendingBaselineReads.get(fileId) === settled) {
      pendingBaselineReads.delete(fileId)
    }
  })
}

export async function waitForKeepEditsBaselineReads(fileIds: readonly string[]): Promise<void> {
  await Promise.all(fileIds.map((fileId) => pendingBaselineReads.get(fileId) ?? Promise.resolve()))
}
