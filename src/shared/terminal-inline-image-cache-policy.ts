export const TERMINAL_INLINE_IMAGE_CACHE_MB_DEFAULT = 32
// Keep enough room for a Kitty decoder; cap each pane below the addon's 1000 MB maximum.
export const TERMINAL_INLINE_IMAGE_CACHE_MB_MIN = 32
export const TERMINAL_INLINE_IMAGE_CACHE_MB_MAX = 512
export const TERMINAL_INLINE_IMAGE_CACHE_MB_PRESETS = [32, 64, 128, 256, 512] as const

export function normalizeTerminalInlineImageCacheMb(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return TERMINAL_INLINE_IMAGE_CACHE_MB_DEFAULT
  }
  return Math.min(
    TERMINAL_INLINE_IMAGE_CACHE_MB_MAX,
    Math.max(TERMINAL_INLINE_IMAGE_CACHE_MB_MIN, Math.floor(value))
  )
}
