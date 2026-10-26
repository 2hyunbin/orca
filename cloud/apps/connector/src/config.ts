import { z } from 'zod'

const OptionalTextSchema = z.string().min(1).optional()

const EnvSchema = z.object({
  ORCA_CONNECTOR_MODE: z.enum(['active', 'validation']).default('active'),
  PORT: z.coerce.number().int().positive().default(8080),
  ORCA_CONNECTOR_PUBLIC_URL: z.string().url(),
  ORCA_CONNECTOR_DATABASE_URL: OptionalTextSchema,
  ORCA_CONNECTOR_DATA_DIR: z.string().min(1).default('./data/connector'),
  ORCA_CONNECTOR_DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
  ORCA_CONNECTOR_AUTH_URL: z.string().url(),
  ORCA_CONNECTOR_AUTH_CLIENT_ID: z.string().min(1).default('orca-connector'),
  // Signs the browser's sign-in cookies; rotating it signs every browser out.
  ORCA_CONNECTOR_COOKIE_SECRET: z.string().min(32),
  // As push: proxies appending to x-forwarded-for after the client (0 is Cloud Run alone).
  ORCA_CONNECTOR_TRUSTED_PROXY_HOPS: z.coerce.number().int().nonnegative().max(8).default(0),
  // A header the load balancer sets to the client's rough location, overwriting any client copy.
  // Unset means the sign-in page shows only the address.
  ORCA_CONNECTOR_CLIENT_LOCATION_HEADER: OptionalTextSchema
})

export type ConnectorConfig = {
  mode: 'active' | 'validation'
  port: number
  publicUrl: string
  databaseUrl?: string
  dataDir: string
  databasePoolMax: number
  authUrl: string
  authClientId: string
  cookieSecret: string
  trustedProxyHops: number
  clientLocationHeader?: string
}

function canonicalOrigin(value: string, name: string): string {
  const url = new URL(value)
  if (url.origin !== value) {
    throw new Error(`${name} must be an origin`)
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error(`${name} must use HTTPS outside loopback development`)
  }
  return value
}

export function loadConnectorConfig(env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
  const parsed = EnvSchema.parse(
    Object.fromEntries(
      Object.entries(env).map(([key, value]) => [key, value?.trim() === '' ? undefined : value])
    )
  )
  return {
    mode: parsed.ORCA_CONNECTOR_MODE,
    port: parsed.PORT,
    publicUrl: canonicalOrigin(parsed.ORCA_CONNECTOR_PUBLIC_URL, 'ORCA_CONNECTOR_PUBLIC_URL'),
    ...(parsed.ORCA_CONNECTOR_DATABASE_URL === undefined
      ? {}
      : { databaseUrl: parsed.ORCA_CONNECTOR_DATABASE_URL }),
    dataDir: parsed.ORCA_CONNECTOR_DATA_DIR,
    databasePoolMax: parsed.ORCA_CONNECTOR_DATABASE_POOL_MAX,
    authUrl: canonicalOrigin(parsed.ORCA_CONNECTOR_AUTH_URL, 'ORCA_CONNECTOR_AUTH_URL'),
    authClientId: parsed.ORCA_CONNECTOR_AUTH_CLIENT_ID,
    cookieSecret: parsed.ORCA_CONNECTOR_COOKIE_SECRET,
    trustedProxyHops: parsed.ORCA_CONNECTOR_TRUSTED_PROXY_HOPS,
    ...(parsed.ORCA_CONNECTOR_CLIENT_LOCATION_HEADER === undefined
      ? {}
      : { clientLocationHeader: parsed.ORCA_CONNECTOR_CLIENT_LOCATION_HEADER.toLowerCase() })
  }
}
