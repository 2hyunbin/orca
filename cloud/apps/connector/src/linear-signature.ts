import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

const MAX_TIMESTAMP_SKEW_MS = 60_000
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/i
const DELIVERY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Read only after the signature passes, so the timestamp is the signed one, not the header copy.
const SignedTimestampSchema = z.looseObject({ webhookTimestamp: z.number() })

export type LinearWebhook = { deliveryId: string; payload: unknown }

// Linear's scheme: hex HMAC-SHA256 over the raw body in Linear-Signature, then the body's
// webhookTimestamp (ms) within a minute of our clock (replay window). Linear-Delivery names the payload.
export function verifyLinearWebhook(input: {
  signingSecret: string
  signature: string | undefined
  deliveryId: string | undefined
  rawBody: string
  nowMs: number
}): LinearWebhook | null {
  const { signature, deliveryId } = input
  if (!signature || !SIGNATURE_PATTERN.test(signature) || !deliveryId) {
    return null
  }
  if (!DELIVERY_PATTERN.test(deliveryId)) {
    return null
  }
  const expected = createHmac('sha256', input.signingSecret).update(input.rawBody).digest()
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), expected)) {
    return null
  }
  let payload: unknown
  try {
    payload = JSON.parse(input.rawBody)
  } catch {
    return null
  }
  const signed = SignedTimestampSchema.safeParse(payload)
  if (
    !signed.success ||
    Math.abs(input.nowMs - signed.data.webhookTimestamp) > MAX_TIMESTAMP_SKEW_MS
  ) {
    return null
  }
  return { deliveryId: deliveryId.toLowerCase(), payload }
}
