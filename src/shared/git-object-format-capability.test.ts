import { describe, expect, it } from 'vitest'
import { isUnsupportedGitSha256InitError } from './git-object-format-capability'

describe('SHA-256 init compatibility errors', () => {
  it.each([
    "error: unknown option 'object-format=sha256'",
    'error: unrecognized option --object-format=sha256',
    "fatal: unknown hash algorithm 'sha256'",
    'fatal: The hash algorithm sha256 is not supported in this build.'
  ])('recognizes a positive unsupported signal: %s', (stderr) => {
    expect(isUnsupportedGitSha256InitError({ stderr })).toBe(true)
  })

  it.each([
    new Error('Permission denied'),
    new Error('No space left on device'),
    new Error('Connection timed out'),
    new Error("error: unknown option 'unrelated'"),
    new Error("fatal: unknown hash algorithm 'sha512'"),
    null,
    'unknown option object-format'
  ])('does not cache an unrelated failure: %s', (error) => {
    expect(isUnsupportedGitSha256InitError(error)).toBe(false)
  })
})
