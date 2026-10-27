import { extractExecError } from '../git/exec-error'
import { parseGlabApiResponse } from './glab-api-response'
import { glabExecFileAsync } from './gl-utils'

type DraftMutationResponse = {
  data?: {
    mergeRequestSetDraft?: { errors?: unknown; mergeRequest?: { iid?: unknown } | null }
  } | null
  errors?: {
    message?: unknown
    extensions?: { code?: unknown; fieldName?: unknown; typeName?: unknown }
  }[]
}

function parseDraftResponse(stdout: string): { body: string; status?: number } {
  const status = /^HTTP\/\d+(?:\.\d+)?\s+(\d{3})(?:\s|$)/.exec(stdout)?.[1]
  return { body: parseGlabApiResponse(stdout).body, status: status ? Number(status) : undefined }
}

function isUnsupportedDraftMutation(stdout: string, stderr: string): boolean {
  const response = parseDraftResponse(stdout)
  if (
    /\b(?:unauthorized|forbidden|insufficient_scope|access denied|not authorized)\b/i.test(stderr)
  ) {
    return false
  }
  if (response.status === 404) {
    return true
  }
  if (response.status !== undefined && response.status !== 200) {
    return false
  }
  try {
    const payload = JSON.parse(response.body) as DraftMutationResponse | null
    return (
      !payload?.data &&
      Array.isArray(payload?.errors) &&
      payload.errors.length > 0 &&
      payload.errors.every(
        (error) =>
          (error?.extensions?.code === 'undefinedField' &&
            error.extensions.typeName === 'Mutation' &&
            error.extensions.fieldName === 'mergeRequestSetDraft') ||
          (!error?.extensions &&
            (error?.message === "Field 'mergeRequestSetDraft' doesn't exist on type 'Mutation'" ||
              error?.message === 'Schema is not configured for mutations'))
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
    const exit = error as { code?: unknown; killed?: unknown; signal?: unknown } | null
    // A terminated command cannot confirm that GitLab rejected the operation before execution.
    if (
      exit?.code === 1 &&
      !exit.killed &&
      !exit.signal &&
      isUnsupportedDraftMutation(output.stdout, output.stderr)
    ) {
      return false
    }
    throw error
  }

  const failure = new Error('GitLab could not mark the merge request ready. Try again.')
  const response = parseDraftResponse(stdout)
  let payload: DraftMutationResponse | null
  try {
    payload = JSON.parse(response.body) as DraftMutationResponse | null
  } catch {
    throw failure
  }
  const mutation = payload?.data?.mergeRequestSetDraft
  if (
    (response.status !== undefined && response.status !== 200) ||
    (payload?.errors !== undefined &&
      (!Array.isArray(payload.errors) || payload.errors.length > 0)) ||
    !mutation ||
    !Array.isArray(mutation.errors) ||
    mutation.errors.length > 0 ||
    mutation.mergeRequest?.iid !== String(iid)
  ) {
    throw failure
  }
  return true
}
