import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { z } from 'zod'
import type { ConnectorConfig } from './config.js'

export const CONNECTOR_TOKEN_AUDIENCE = 'orca-connector'

// Minted by the auth service's connector token route, as relay tokens are by its relay route.
const ClaimsSchema = z.object({
  sub: z.string().min(1),
  prof: z.string().min(1),
  org: z.string().min(1).optional(),
  sid: z.string().min(1),
  // Random per-install id; its alphabet has no ':', so `${sub}:${mid}` names one machine of one account.
  mid: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  purpose: z.literal('connector-host'),
  exp: z.number().int().positive()
})

export type ConnectorTokenClaims = z.infer<typeof ClaimsSchema>
export type ConnectorTokenVerifier = (token: string) => Promise<ConnectorTokenClaims | null>

export function connectorHostId(claims: Pick<ConnectorTokenClaims, 'sub' | 'mid'>): string {
  return `${claims.sub}:${claims.mid}`
}

// No stale-if-error key cache as the relay has: tokens last 5 min and only auth mints them, so an
// auth outage ends every machine's access within minutes either way.
export function createConnectorTokenVerifier(
  config: Pick<ConnectorConfig, 'authIssuer' | 'jwksUrl'>,
  jwks: JWTVerifyGetKey = createRemoteJWKSet(new URL(config.jwksUrl))
): ConnectorTokenVerifier {
  return async (token) => {
    try {
      const verified = await jwtVerify(token, jwks, {
        issuer: config.authIssuer,
        audience: CONNECTOR_TOKEN_AUDIENCE,
        algorithms: ['ES256']
      })
      return ClaimsSchema.parse(verified.payload)
    } catch {
      return null
    }
  }
}

export function readBearer(value: string | undefined): string | null {
  const match = /^Bearer ([^\s]+)$/.exec(value ?? '')
  return match?.[1] ?? null
}
