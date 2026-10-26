import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// What a sealed value is; part of its AAD, so a value sealed for one use won't open as another.
export type SealPurpose = 'slack-bot-token' | 'slack-signing-secret' | 'slack-client-secret'

// The row a value belongs to, e.g. [appId] or [teamId, appId]; a sealed value copied to another
// row won't open.
const aad = (purpose: SealPurpose, binding: readonly string[]) =>
  Buffer.from([purpose, ...binding].join('\0'))

// AES-256-GCM under the Slack token key.
export function sealSecret(
  key: Buffer,
  purpose: SealPurpose,
  binding: readonly string[],
  value: string
): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(aad(purpose, binding))
  const sealed = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return ['v1', ...[iv, cipher.getAuthTag(), sealed].map((part) => part.toString('base64'))].join(
    '.'
  )
}

export function openSecret(
  key: Buffer,
  purpose: SealPurpose,
  binding: readonly string[],
  sealed: string
): string {
  const [version, iv, tag, data] = sealed.split('.')
  if (version !== 'v1' || !iv || !tag || !data) {
    throw new Error('unreadable sealed secret')
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
    .setAAD(aad(purpose, binding))
    .setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
    'utf8'
  )
}
