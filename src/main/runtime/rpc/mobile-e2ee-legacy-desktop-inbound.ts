import { decrypt, decryptBytes } from './e2ee-crypto'

/** One inbound frame on a legacy (static-ECDH) socket; mirrors the v2 inbound handler. */
export function handleDesktopMobileE2EELegacyInbound(args: {
  sharedKey: Uint8Array
  raw: string | Uint8Array<ArrayBufferLike>
  state: 'awaiting_auth' | 'redeeming' | 'ready'
  onDecryptFailure: () => void
  onDecryptSuccess: () => void
  onAuth: (plaintext: string) => void
  onText: (plaintext: string) => void
  onBinary: (plaintext: Uint8Array<ArrayBufferLike>) => void
  onProtocolError: () => void
}): void {
  if (typeof args.raw !== 'string') {
    const plaintextBytes = decryptBytes(args.raw, args.sharedKey)
    if (plaintextBytes === null) {
      args.onDecryptFailure()
      return
    }
    args.onDecryptSuccess()
    if (args.state !== 'ready') {
      args.onProtocolError()
      return
    }
    args.onBinary(plaintextBytes)
    return
  }
  const plaintext = decrypt(args.raw, args.sharedKey)
  if (plaintext === null) {
    args.onDecryptFailure()
    return
  }
  args.onDecryptSuccess()
  if (args.state === 'awaiting_auth') {
    args.onAuth(plaintext)
    return
  }
  args.onText(plaintext)
}
