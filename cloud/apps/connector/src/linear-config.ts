import { z } from 'zod'

export type LinearConfig = {
  // The OAuth app's webhook signing secret (one per app, not per workspace).
  webhookSecret: string
  clientId: string
  clientSecret: string
  // Signs the operator's install links (OAuth state).
  installStateKey: string
  // As Slack's Q20 allowlist: events from any other Linear workspace are acknowledged and ignored.
  organizationIds: ReadonlySet<string>
  // Cloud-wide kill switch: ingress still answers 200 but queues nothing.
  paused: boolean
}

const LinearEnvSchema = z.object({
  ORCA_CONNECTOR_LINEAR_WEBHOOK_SECRET: z.string().min(1).optional(),
  ORCA_CONNECTOR_LINEAR_CLIENT_ID: z.string().min(1).optional(),
  ORCA_CONNECTOR_LINEAR_CLIENT_SECRET: z.string().min(1).optional(),
  ORCA_CONNECTOR_LINEAR_INSTALL_STATE_KEY: z.string().min(32).optional(),
  ORCA_CONNECTOR_LINEAR_ORGANIZATION_IDS: z.string().min(1).optional(),
  ORCA_CONNECTOR_LINEAR_PAUSED: z.enum(['true', 'false']).default('false')
})

// Linear is off without a webhook secret; with one, the OAuth client, state key and allowlist are
// required too.
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
    ORCA_CONNECTOR_LINEAR_INSTALL_STATE_KEY: installStateKey
  } = parsed
  if (
    organizationIds.length === 0 ||
    clientId === undefined ||
    clientSecret === undefined ||
    installStateKey === undefined
  ) {
    throw new Error(
      'Linear needs ORCA_CONNECTOR_LINEAR_CLIENT_ID, ORCA_CONNECTOR_LINEAR_CLIENT_SECRET, ORCA_CONNECTOR_LINEAR_INSTALL_STATE_KEY and ORCA_CONNECTOR_LINEAR_ORGANIZATION_IDS'
    )
  }
  return {
    webhookSecret: secret,
    clientId,
    clientSecret,
    installStateKey,
    organizationIds: new Set(organizationIds),
    paused: parsed.ORCA_CONNECTOR_LINEAR_PAUSED === 'true'
  }
}
