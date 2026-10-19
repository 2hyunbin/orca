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
export function assertRemoteCliPageAdmitted(
  webContentsId: number | undefined,
  method?: string,
  params?: Record<string, unknown>
): void {
  if (webContentsId !== undefined && !isInputReleaseCommand(method, params)) {
    admissions.get(webContentsId)?.()
  }
}

/** Ends input a command already began; refusing it would leave a button or key held on the page. */
export function isInputReleaseCommand(method?: string, params?: Record<string, unknown>): boolean {
  const type = params?.type
  switch (method) {
    case 'Input.dispatchMouseEvent':
      return type === 'mouseReleased'
    case 'Input.dispatchKeyEvent':
      return type === 'keyUp'
    case 'Input.dispatchTouchEvent':
      return type === 'touchEnd' || type === 'touchCancel'
    default:
      return false
  }
}
