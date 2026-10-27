import { extractExecError } from '../git/exec-error'
import { glabExecFileAsync } from './gl-utils'

type DraftMutationResponse = {
  data?: {
    mergeRequestSetDraft?: { errors?: unknown; mergeRequest?: { iid?: unknown } | null }
  } | null
  errors?: { extensions?: { code?: unknown; fieldName?: unknown } }[]
  message?: unknown
  error?: unknown
}

function isUnsupportedDraftMutation(stdout: string, stderr: string): boolean {
  try {
    const payload = JSON.parse(stdout) as DraftMutationResponse | null
    if (
      /\bHTTP 404\b/.test(stderr) &&
      (payload?.message === '404 Not Found' || payload?.error === '404 Not Found')
    ) {
      return true
    }
    return (
      !payload?.data &&
      Array.isArray(payload?.errors) &&
      payload.errors.length > 0 &&
      payload.errors.every(
        (error) =>
          error?.extensions?.code === 'undefinedField' &&
          error.extensions.fieldName === 'mergeRequestSetDraft'
      )
    )
  } catch {
    return false
  }
}

export async function tryMarkMRReady(
  args: string[],
  options: Parameters<typeof glabExecFileAsync>[1],
  iid: number
): Promise<boolean> {
  let stdout: string
  try {
    ;({ stdout } = await glabExecFileAsync(args, options))
  } catch (error) {
    const output = extractExecError(error)
    // Only a provider declaration of unsupported readiness permits the legacy title write.
    if (isUnsupportedDraftMutation(output.stdout, output.stderr)) {
      return false
    }
    throw error
  }

  const failure = new Error('GitLab could not mark the merge request ready. Try again.')
  let payload: DraftMutationResponse | null
  try {
    payload = JSON.parse(stdout) as DraftMutationResponse | null
  } catch {
    throw failure
  }
  const mutation = payload?.data?.mergeRequestSetDraft
  if (
    (payload?.errors !== undefined &&
      (!Array.isArray(payload.errors) || payload.errors.length > 0)) ||
    !Array.isArray(mutation?.errors) ||
    mutation.errors.length > 0 ||
    mutation.mergeRequest?.iid !== String(iid)
  ) {
    throw failure
  }
  return true
}
