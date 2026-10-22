import { NativeModules } from 'react-native'
import {
  OrcaGzipUtf8Codec,
  type OrcaGzipUtf8CodecModule
} from '../../modules/orca-gzip-utf8-codec/src'

declare global {
  // Installed by react-native-libsodium's native install; unknown until checked.
  var jsi_from_base64_to_arraybuffer: unknown
  var jsi_crypto_secretbox_open_easy: unknown
}

/** The two react-native-libsodium JSI functions the download needs; both throw on failure. */
export type LibsodiumBindings = {
  fromBase64: (value: string, variant: number) => ArrayBuffer
  secretboxOpen: (box: ArrayBuffer, nonce: ArrayBuffer, key: ArrayBuffer) => ArrayBuffer
}

export type PairedE2EENativeBindings = {
  codec: OrcaGzipUtf8CodecModule
  sodium: LibsodiumBindings
}

/** Null when either native piece is missing from this binary. */
export function loadPairedE2EENativeBindings(): PairedE2EENativeBindings | null {
  const sodium = installLibsodium()
  return sodium && OrcaGzipUtf8Codec ? { codec: OrcaGzipUtf8Codec, sodium } : null
}

/**
 * react-native-libsodium's JS entry installs its JSI functions on import, logs as it does, and
 * wraps every call; only its native install and two of the functions are needed here.
 */
function installLibsodium(): LibsodiumBindings | null {
  const libsodium: { install?: unknown } | undefined = NativeModules.Libsodium
  if (typeof libsodium?.install !== 'function') {
    return null
  }
  libsodium.install()
  const fromBase64 = globalThis.jsi_from_base64_to_arraybuffer
  const secretboxOpen = globalThis.jsi_crypto_secretbox_open_easy
  if (typeof fromBase64 !== 'function' || typeof secretboxOpen !== 'function') {
    return null
  }
  return {
    fromBase64: (value, variant) => arrayBufferOf(fromBase64(value, variant)),
    secretboxOpen: (box, nonce, key) => arrayBufferOf(secretboxOpen(box, nonce, key))
  }
}

function arrayBufferOf(value: unknown): ArrayBuffer {
  if (!(value instanceof ArrayBuffer)) {
    throw new TypeError('libsodium returned something other than an ArrayBuffer')
  }
  return value
}
