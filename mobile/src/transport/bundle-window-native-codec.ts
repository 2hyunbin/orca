import { loadBundleWindowNativeBindings } from './bundle-window-native-bindings'

/** The decode steps of a page-bundle download window, done natively instead of in Hermes JS. */
export type BundleWindowNativeCodec = {
  /** Canonical padded base64 only; null for anything else, including what `atob` forgives. */
  decodeBase64(value: string): Uint8Array | null
  /** XSalsa20-Poly1305 secretbox open; null for a box that fails authentication. */
  openSecretbox(box: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null
  /** Throws on a body that is not one well-formed gzip member. See OrcaBundleWindowCodecModule. */
  gunzip(input: Uint8Array, outputLimit: number): Uint8Array
  /** Null where only TextDecoder's replacement or BOM rules give the answer. */
  decodeUtf8(input: Uint8Array): string | null
}

// libsodium's sodium_base64_VARIANT_ORIGINAL: the standard alphabet, padded.
const SODIUM_BASE64_ORIGINAL = 1
const SECRETBOX_MAC_BYTES = 16

// A box sealed by tweetnacl under key 0..31 and nonce 0..23, and a gzip member, both of "ok".
const PROBE_BOX_BASE64 = 'sqQBX9c2fQaZ4F6j8gHDpjGU'
const PROBE_GZIP_BASE64 = 'H4sIAAAAAAAAE8vPBgBH3dx5AgAAAA=='

let detected: BundleWindowNativeCodec | null | undefined

/**
 * The native codec, or null when any part of it is missing or answers the probe wrongly; the
 * caller then runs the JS path for the whole download. Detected once, on first use.
 */
export function bundleWindowNativeCodec(): BundleWindowNativeCodec | null {
  if (detected === undefined) {
    detected = detectBundleWindowNativeCodec()
  }
  return detected
}

function detectBundleWindowNativeCodec(): BundleWindowNativeCodec | null {
  try {
    const bindings = loadBundleWindowNativeBindings()
    if (!bindings) {
      return null
    }
    const { codec: module, sodium } = bindings
    const codec: BundleWindowNativeCodec = {
      decodeBase64: (value) => {
        // Why: libsodium sizes its output from the input, and an empty one has nothing to size.
        if (value.length === 0) {
          return new Uint8Array(0)
        }
        try {
          return new Uint8Array(sodium.fromBase64(value, SODIUM_BASE64_ORIGINAL))
        } catch {
          return null
        }
      },
      openSecretbox: (box, nonce, key) => {
        // Why: libsodium's output length underflows below the MAC length and crashes the app.
        if (box.length < SECRETBOX_MAC_BYTES) {
          return null
        }
        try {
          return new Uint8Array(
            sodium.secretboxOpen(wholeBuffer(box), wholeBuffer(nonce), wholeBuffer(key))
          )
        } catch {
          // libsodium throws where tweetnacl returns null: a forged or corrupted box.
          return null
        }
      },
      gunzip: (input, outputLimit) => module.gunzip(input, outputLimit),
      decodeUtf8: (input) => module.decodeUtf8(input)
    }
    return answersProbe(codec) ? codec : null
  } catch {
    return null
  }
}

function answersProbe(codec: BundleWindowNativeCodec): boolean {
  const box = codec.decodeBase64(PROBE_BOX_BASE64)
  const gzip = codec.decodeBase64(PROBE_GZIP_BASE64)
  if (!box || !gzip) {
    return false
  }
  const key = Uint8Array.from({ length: 32 }, (_, index) => index)
  const nonce = Uint8Array.from({ length: 24 }, (_, index) => index)
  const opened = codec.openSecretbox(box, nonce, key)
  return (
    opened !== null &&
    codec.decodeUtf8(opened) === 'ok' &&
    codec.decodeUtf8(codec.gunzip(gzip, 3)) === 'ok' &&
    codec.decodeBase64('b2s=') !== null &&
    codec.decodeBase64('b2t=') === null
  )
}

/** libsodium reads whole ArrayBuffers, so a view into a larger one is copied out first. */
function wholeBuffer(view: Uint8Array): ArrayBuffer {
  const { buffer } = view
  if (
    buffer instanceof ArrayBuffer &&
    view.byteOffset === 0 &&
    view.byteLength === buffer.byteLength
  ) {
    return buffer
  }
  return view.slice().buffer
}
