export function isUnsupportedGitSha256InitError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const message = 'message' in error && typeof error.message === 'string' ? error.message : ''
  const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : ''
  return /(?:unknown|invalid|unrecognized) (?:switch|option)[^\r\n]*object-format\b|(?:unknown hash algorithm|hash algorithm[^\r\n]*not supported)[^\r\n]*sha256|hash algorithm sha256 is not supported/i.test(
    `${message}\n${stderr}`
  )
}
