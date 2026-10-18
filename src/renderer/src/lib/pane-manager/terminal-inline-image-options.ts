import type { IImageAddonOptions } from '@xterm/addon-image'

// Per-sequence byte ceiling for every protocol. Bounds the decoder's working
// buffer so one oversized paste cannot stall the parser or balloon memory; 8 MB
// of encoded data still covers any reasonable inline image.
const IMAGE_SEQUENCE_SIZE_LIMIT = 8 * 1024 * 1024

// This limits decoded storage; encoded sources and pending decoders use separate budgets.

/** Bound image sequences and per-pane caches without enabling duplicate size reports. */
export function buildInlineImageAddonOptions(storageLimitMb: number): IImageAddonOptions {
  return {
    // Orca already answers CSI 14t/16t via its pixel-size responder.
    enableSizeReports: false,
    storageLimit: storageLimitMb,
    pixelLimit: 8_000_000,
    sixelSizeLimit: IMAGE_SEQUENCE_SIZE_LIMIT,
    iipSizeLimit: IMAGE_SEQUENCE_SIZE_LIMIT,
    kittySizeLimit: IMAGE_SEQUENCE_SIZE_LIMIT
  }
}
