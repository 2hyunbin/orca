/**
 * The pages an SSH host's command is driving right now, each with the check that refuses its next
 * step once that host is revoked. Every page-affecting sink (guest CDP sends, native input events,
 * edit commands) consults it, so no queued or deferred step of a running command outlives the
 * revocation.
 */
const admissions = new Map<number, () => void>()

export async function runWithRemoteCliPageAdmission<T>(
  webContentsId: number,
  admit: () => void,
  run: () => Promise<T>
): Promise<T> {
  admissions.set(webContentsId, admit)
  try {
    return await run()
  } finally {
    if (admissions.get(webContentsId) === admit) {
      admissions.delete(webContentsId)
    }
  }
}

/** Throws while a revoked host's command still holds this page; a no-op otherwise. */
export function assertRemoteCliPageAdmitted(webContentsId: number | undefined): void {
  if (webContentsId !== undefined) {
    admissions.get(webContentsId)?.()
  }
}
