import { deriveSharedKey } from './e2ee-crypto'
import { decodeMobileE2EEPublicKey } from './mobile-e2ee-auth-validation'
import {
  DesktopMobileE2EEV2Session,
  type DesktopMobileE2EEV2Context
} from './mobile-e2ee-v2-desktop-session'
import { parseRemoteRuntimeJsonText } from '../../../shared/remote-runtime-request-frames'

export type E2EEHelloAcceptance =
  | { kind: 'v2'; session: DesktopMobileE2EEV2Session; readyText: string }
  | { kind: 'legacy'; sharedKey: Uint8Array; readyText: string }
  | { kind: 'refused'; reason: string }

/** Validates a client's hello and derives the keys for the framing it asked for. */
export function acceptE2EEHello(
  raw: string,
  args: {
    serverSecretKey: Uint8Array
    transportContext: DesktopMobileE2EEV2Context
    requireV2: boolean
  }
): E2EEHelloAcceptance {
  let hello: Record<string, unknown>
  try {
    hello = parseRemoteRuntimeJsonText(raw) as Record<string, unknown>
  } catch {
    return { kind: 'refused', reason: 'Invalid handshake message' }
  }
  if (hello.type === 'e2ee_hello' && hello.v === 2) {
    const session = DesktopMobileE2EEV2Session.create({
      hello,
      serverSecretKey: args.serverSecretKey,
      expectedContext: args.transportContext
    })
    return session
      ? { kind: 'v2', session, readyText: JSON.stringify(session.ready) }
      : { kind: 'refused', reason: 'Invalid e2ee_hello v2' }
  }
  if (args.requireV2) {
    return { kind: 'refused', reason: 'E2EE v2 required' }
  }
  if (hello.type !== 'e2ee_hello' || typeof hello.publicKeyB64 !== 'string') {
    return { kind: 'refused', reason: 'Invalid e2ee_hello' }
  }
  // Why: derive the shared key from our secret + client's public key (static ECDH).
  const clientPublicKey = decodeMobileE2EEPublicKey(hello.publicKeyB64)
  if (!clientPublicKey) {
    return { kind: 'refused', reason: 'Invalid public key' }
  }
  return {
    kind: 'legacy',
    sharedKey: deriveSharedKey(args.serverSecretKey, clientPublicKey),
    // Why plaintext: the client needs it to know the key exchange succeeded before it can
    // send encrypted authentication.
    readyText: JSON.stringify({ type: 'e2ee_ready' })
  }
}
