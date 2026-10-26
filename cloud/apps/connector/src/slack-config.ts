import { z } from 'zod'

export type SlackConfig = {
  // Cloud-wide kill switch: ingress still answers 200 but queues nothing.
  paused: boolean
  // AES-256 key (from Secret Manager) sealing every stored Slack secret: bot tokens and each app's
  // client and signing secrets.
  tokenKey: Buffer
}

const SlackEnvSchema = z.object({
  ORCA_CONNECTOR_SLACK_PAUSED: z.enum(['true', 'false']).default('false'),
  ORCA_CONNECTOR_SLACK_TOKEN_KEY: z.string().min(1).optional()
})

export function decodeSlackTokenKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64')
  if (key.length !== 32 || key.toString('base64') !== value) {
    throw new Error('ORCA_CONNECTOR_SLACK_TOKEN_KEY must be 32 bytes in canonical base64')
  }
  return key
}

// Slack is off without a token key. Which apps and workspaces it serves are rows, not settings.
export function parseSlackConfig(env: Record<string, string | undefined>): SlackConfig | undefined {
  const parsed = SlackEnvSchema.parse(env)
  if (parsed.ORCA_CONNECTOR_SLACK_TOKEN_KEY === undefined) {
    return undefined
  }
  return {
    paused: parsed.ORCA_CONNECTOR_SLACK_PAUSED === 'true',
    tokenKey: decodeSlackTokenKey(parsed.ORCA_CONNECTOR_SLACK_TOKEN_KEY)
  }
}
