/**
 * The pages an SSH host's command is driving right now, each with the check that refuses its next
 * step once that host is revoked. Every page-affecting sink (guest CDP sends, native input events,
 * edit commands) consults it, so no queued or deferred step of a running command outlives the
 * revocation.
 */
type Admission = {
  admit: () => void
  /** Buttons, keys and touches this command pressed; only their release outlives a revocation. */
  held: Set<string>
}

const admissions = new Map<number, Admission>()

export async function runWithRemoteCliPageAdmission<T>(
  webContentsId: number,
  admit: () => void,
  run: () => Promise<T>
): Promise<T> {
  const admission: Admission = { admit, held: new Set() }
  admissions.set(webContentsId, admission)
  try {
    return await run()
  } finally {
    if (admissions.get(webContentsId) === admission) {
      admissions.delete(webContentsId)
    }
  }
}

/**
 * Throws while a revoked host's command still holds this page; a no-op otherwise. Pass the input
 * being sent so a release of what this command pressed still lands instead of leaving it held.
 */
export function assertRemoteCliPageAdmitted(
  webContentsId: number | undefined,
  method?: string,
  params?: Record<string, unknown>
): void {
  const admission = webContentsId === undefined ? undefined : admissions.get(webContentsId)
  if (!admission) {
    return
  }
  const input = describeInput(method, params)
  if (input && !input.press && admission.held.has(input.id)) {
    return
  }
  admission.admit()
  if (input?.press) {
    admission.held.add(input.id)
  }
}

/** True for a release of something the command now holding this page pressed. */
export function isHeldRemoteCliInputRelease(
  webContentsId: number | undefined,
  method: string,
  params?: Record<string, unknown>
): boolean {
  const input = describeInput(method, params)
  return (
    input !== null &&
    !input.press &&
    webContentsId !== undefined &&
    (admissions.get(webContentsId)?.held.has(input.id) ?? false)
  )
}

/** Records a press the command holding this page sent outside the admission gates. */
export function noteRemoteCliInputPress(
  webContentsId: number | undefined,
  method: string,
  params?: Record<string, unknown>
): void {
  const input = describeInput(method, params)
  if (input?.press && webContentsId !== undefined) {
    admissions.get(webContentsId)?.held.add(input.id)
  }
}

function describeInput(
  method: string | undefined,
  params: Record<string, unknown> | undefined
): { id: string; press: boolean } | null {
  const type = params?.type
  switch (method) {
    case 'Input.dispatchMouseEvent':
      return type === 'mousePressed' || type === 'mouseReleased'
        ? { id: `mouse:${String(params?.button ?? 'left')}`, press: type === 'mousePressed' }
        : null
    case 'Input.dispatchKeyEvent':
      return type === 'keyDown' || type === 'rawKeyDown' || type === 'keyUp'
        ? { id: `key:${String(params?.code ?? params?.key ?? '')}`, press: type !== 'keyUp' }
        : null
    case 'Input.dispatchTouchEvent':
      return type === 'touchStart' || type === 'touchEnd' || type === 'touchCancel'
        ? { id: 'touch', press: type === 'touchStart' }
        : null
    default:
      return null
  }
}
