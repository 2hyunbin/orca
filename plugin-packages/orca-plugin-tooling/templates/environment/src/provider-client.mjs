import {
  environmentRecipeRequestSchema,
  environmentRecipeRecoveryRequestSchema,
  parseEnvironmentRecipeResponse,
  parseEnvironmentRecipeRecoveryResponse,
  ENVIRONMENT_RECIPE_OUTPUT_BYTES
} from '../.orca-tooling/dist/runtime.mjs'

async function responseText(response) {
  if (!response.body) {
    throw new Error('Provider returned no response')
  }
  const reader = response.body.getReader(),
    chunks = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) {
        break
      }
      size += next.value.byteLength
      if (size > ENVIRONMENT_RECIPE_OUTPUT_BYTES) {
        throw new Error('Provider response exceeded its byte limit')
      }
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
}

export async function handleProviderRequest(raw, environment, fetcher = fetch) {
  const recovery = Boolean(raw && typeof raw === 'object' && Object.hasOwn(raw, 'queryId'))
  const request = (
    recovery ? environmentRecipeRecoveryRequestSchema : environmentRecipeRequestSchema
  ).parse(raw)
  if (!recovery && request.protocolVersion !== 2) {
    throw new Error('Provider requires an explicit account context')
  }
  const identity = recovery
    ? request
    : {
        protocolVersion: 2,
        providerId: request.providerId,
        contextId: request.contextId,
        operationId: request.operationId,
        action: request.action
      }
  const base = environment.ORCA_ENVIRONMENT_PROVIDER_URL,
    token = environment.ORCA_ENVIRONMENT_PROVIDER_TOKEN
  if (!base || !token) {
    return {
      ...identity,
      kind: 'error',
      code: 'authentication-required',
      ...(recovery
        ? {}
        : { message: 'Configure this control host’s company provider URL and credentials.' })
    }
  }
  const url = new URL(base)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(
      'Provider base URL must be HTTPS without embedded credentials, query or fragment'
    )
  }
  if (!url.pathname.endsWith('/')) {
    url.pathname += '/'
  }
  const endpoint = new URL(recovery ? 'receipts' : 'operations', url)
  const response = await fetcher(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(110000)
  })
  if (!response.ok) {
    throw new Error('Provider did not confirm a successful response')
  }
  const text = await responseText(response)
  return (recovery ? parseEnvironmentRecipeRecoveryResponse : parseEnvironmentRecipeResponse)(
    text,
    request
  )
}
