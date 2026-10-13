export const STL_LIMITS = {
  inputBytes: 50 * 1024 * 1024,
  triangles: 100_000,
  chunkBytes: 192 * 1024,
  parseMs: 10_000,
  renderMs: 1500,
  rasterSamples: 8_000_000,
  canvasDimension: 1024
} as const

export class StlFailure extends Error {
  constructor(readonly code: 'unsupported_format' | 'limit_exceeded' | 'parse_failed') {
    super(code)
  }
}
