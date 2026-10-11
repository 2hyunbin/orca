// Why request types outside DaemonRequest: an older daemon rejects them as unknown, which a
// client reads as "no gate", and the server answers them before the session router.
export type AutomaticWorkRequestType = 'automaticWorkStatus' | 'resumeAutomaticWork'

export function automaticWorkRequestType(request: {
  type: string
}): AutomaticWorkRequestType | null {
  return request.type === 'automaticWorkStatus' || request.type === 'resumeAutomaticWork'
    ? request.type
    : null
}
