import { z } from 'zod'
import { decodeTokenKey } from './slack-config.js'

export type LinearConfig = {
  // The OAuth app's webhook signing secret (one per app, not per workspace).
  webhookSecret: string
  clientId: string
  clientSecret: string
  // As Slack's Q20 allowlist: events from any other Linear workspace are acknowledged and ignored.
  organizationIds: ReadonlySet<string>
  // Cloud-wide kill switch: ingress still answers 200 but queues nothing.
  paused: boolean
  // AES-256 key (from Secret Manager) sealing the stored access and refresh tokens.
  tokenKey: Buffer
}

const LinearEnvSchema = z.object({
  ORCA_CONNECTOR_LINEAR_WEBHOOK_SECRET: z.string().min(1).optional(),
  ORCA_CONNECTOR_LINEAR_CLIENT_ID: z.string().min(1).optional(),
  ORCA_CONNECTOR_LINEAR_CLIENT_SECRET: z.string().min(1).optional(),
  ORCA_CONNECTOR_LINEAR_ORGANIZATION_IDS: z.string().min(1).optional(),
  ORCA_CONNECTOR_LINEAR_PAUSED: z.enum(['true', 'false']).default('false'),
  ORCA_CONNECTOR_LINEAR_TOKEN_KEY: z.string().min(1).optional()
})

// Linear is off without a webhook secret; with one, the OAuth client, allowlist and key are required.
export function parseLinearConfig(
  env: Record<string, string | undefined>
): LinearConfig | undefined {
  const parsed = LinearEnvSchema.parse(env)
  const secret = parsed.ORCA_CONNECTOR_LINEAR_WEBHOOK_SECRET
  if (secret === undefined) {
    return undefined
  }
  const organizationIds = (parsed.ORCA_CONNECTOR_LINEAR_ORGANIZATION_IDS ?? '')
    .split(',')
    .map((organization) => organization.trim())
    .filter((organization) => organization.length > 0)
  const {
    ORCA_CONNECTOR_LINEAR_CLIENT_ID: clientId,
    ORCA_CONNECTOR_LINEAR_CLIENT_SECRET: clientSecret,
    ORCA_CONNECTOR_LINEAR_TOKEN_KEY: tokenKey
  } = parsed
  if (
    organizationIds.length === 0 ||
    clientId === undefined ||
    clientSecret === undefined ||
    tokenKey === undefined
  ) {
    throw new Error(
      'Linear needs ORCA_CONNECTOR_LINEAR_CLIENT_ID, ORCA_CONNECTOR_LINEAR_CLIENT_SECRET, ORCA_CONNECTOR_LINEAR_ORGANIZATION_IDS and ORCA_CONNECTOR_LINEAR_TOKEN_KEY'
    )
  }
  return {
    webhookSecret: secret,
    clientId,
    clientSecret,
    organizationIds: new Set(organizationIds),
    paused: parsed.ORCA_CONNECTOR_LINEAR_PAUSED === 'true',
    tokenKey: decodeTokenKey(tokenKey, 'ORCA_CONNECTOR_LINEAR_TOKEN_KEY')
  }
}
