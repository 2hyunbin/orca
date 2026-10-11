import { z } from 'zod'
import { isDevicePublicKeyB64 } from './device-key-proof'
import { PAIRING_CODE_MAX_CHARACTERS } from './mobile-pairing-protocol-limits'
import { RuntimeHostDescriptorSchema } from './runtime-host-descriptor'

// Why v3: a v2 offer carries a reusable token; this one carries a single-use ticket. Older apps
// reject it as an invalid code instead of misreading it.
export const PAIRING_TICKET_OFFER_VERSION = 3

export const PairingTicketOfferSchema = z
  .object({
    v: z.literal(PAIRING_TICKET_OFFER_VERSION),
    endpoint: z.string().min(1).max(2048),
    publicKeyB64: z.string().refine(isDevicePublicKeyB64, 'expected a 32-byte key'),
    ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    deviceId: z.string().min(1).max(128),
    scope: z.enum(['runtime', 'mobile']),
    expiresAt: z.number().int().positive(),
    hostDescriptor: RuntimeHostDescriptorSchema.optional()
  })
  .strict()

export type PairingTicketOffer = z.infer<typeof PairingTicketOfferSchema>

/** The secret rides only in the code and the link's fragment, never in a query string. */
export function encodePairingTicketOffer(offer: PairingTicketOffer): {
  code: string
  link: string
} {
  const code = base64UrlFromText(JSON.stringify(PairingTicketOfferSchema.parse(offer)))
  if (code.length > PAIRING_CODE_MAX_CHARACTERS) {
    throw new Error('Pairing ticket offer exceeds safe size')
  }
  return { code, link: `orca://pair#${code}` }
}

export function decodePairingTicketCode(code: string): PairingTicketOffer | null {
  if (code.length > PAIRING_CODE_MAX_CHARACTERS || !/^[A-Za-z0-9_-]+$/.test(code)) {
    return null
  }
  try {
    return PairingTicketOfferSchema.safeParse(JSON.parse(textFromBase64Url(code))).data ?? null
  } catch {
    return null
  }
}

function base64UrlFromText(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function textFromBase64Url(code: string): string {
  const binary = atob(code.replace(/-/g, '+').replace(/_/g, '/'))
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))
}
