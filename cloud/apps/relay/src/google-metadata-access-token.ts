// The project id and the default service account's OAuth token, both from the metadata server.
// Tokens are cached until shortly before Google says they expire.

const METADATA_ROOT = 'http://metadata.google.internal/computeMetadata/v1'
const METADATA_TIMEOUT_MS = 3_000
// Refresh a cached access token this long before Google says it expires.
const ACCESS_TOKEN_EARLY_REFRESH_MS = 60_000

export class GoogleMetadataUnavailableError extends Error {
  constructor() {
    super('google_metadata_unavailable')
  }
}

export type GoogleMetadataAccess = {
  projectId: () => Promise<string>
  accessToken: () => Promise<string>
  // After a 401: the next accessToken() asks the metadata server again.
  forgetAccessToken: () => void
}

export function googleMetadataAccess(fetchImpl: typeof fetch = fetch): GoogleMetadataAccess {
  let projectId: string | null = null
  let accessToken: { value: string; refreshAt: number } | null = null

  const metadata = async (path: string): Promise<Response> =>
    await fetchImpl(`${METADATA_ROOT}/${path}`, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS)
    }).catch(() => {
      throw new GoogleMetadataUnavailableError()
    })

  return {
    projectId: async () => {
      if (projectId) return projectId
      const response = await metadata('project/project-id')
      if (!response.ok) void response.body?.cancel().catch(() => undefined)
      const value = response.ok ? (await response.text()).trim() : ''
      if (!/^[a-z][a-z0-9-]{4,62}$/.test(value)) throw new GoogleMetadataUnavailableError()
      projectId = value
      return value
    },
    accessToken: async () => {
      if (accessToken && Date.now() < accessToken.refreshAt) return accessToken.value
      const response = await metadata('instance/service-accounts/default/token')
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined)
        throw new GoogleMetadataUnavailableError()
      }
      const body: unknown = await response.json().catch(() => null)
      if (
        typeof body !== 'object' ||
        body === null ||
        !('access_token' in body) ||
        typeof body.access_token !== 'string' ||
        !('expires_in' in body) ||
        typeof body.expires_in !== 'number'
      ) {
        throw new GoogleMetadataUnavailableError()
      }
      accessToken = {
        value: body.access_token,
        refreshAt: Date.now() + body.expires_in * 1_000 - ACCESS_TOKEN_EARLY_REFRESH_MS
      }
      return body.access_token
    },
    forgetAccessToken: () => {
      accessToken = null
    }
  }
}
