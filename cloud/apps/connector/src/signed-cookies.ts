import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

const ExpirySchema = z.object({ exp: z.number() })

// HMAC-signed JSON with an expiry; the cookie name is part of the MAC so one cookie cannot stand in for another.
export class SignedCookies {
  constructor(
    private readonly secret: string,
    private readonly now: () => number
  ) {}

  seal(name: string, payload: object, maxAgeMs: number): string {
    const body = Buffer.from(JSON.stringify({ ...payload, exp: this.now() + maxAgeMs })).toString(
      'base64url'
    )
    return `${body}.${this.mac(`${name}.${body}`)}`
  }

  open<T>(name: string, value: string | undefined, schema: z.ZodType<T>): T | null {
    const [body, mac] = value?.split('.') ?? []
    if (!body || !mac || !this.matches(`${name}.${body}`, mac)) {
      return null
    }
    let json: unknown
    try {
      json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    } catch {
      return null
    }
    const expiry = ExpirySchema.safeParse(json)
    if (!expiry.success || this.now() > expiry.data.exp) {
      return null
    }
    const parsed = schema.safeParse(json)
    return parsed.success ? parsed.data : null
  }

  // Bound to the signed session value, so a form token is useless without that browser's cookie.
  csrfToken(sessionCookie: string): string {
    return this.mac(`csrf.${sessionCookie}`)
  }

  csrfMatches(sessionCookie: string, token: string): boolean {
    return this.matches(`csrf.${sessionCookie}`, token)
  }

  private mac(input: string): string {
    return createHmac('sha256', this.secret).update(input).digest('base64url')
  }

  private matches(input: string, mac: string): boolean {
    const expected = Buffer.from(this.mac(input))
    const actual = Buffer.from(mac)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }
}
