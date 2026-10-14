import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveFallbackForegroundProcess } from './foreground-fallback-process'

describe('resolveFallbackForegroundProcess', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads the terminal scope wrappers on Linux as no foreground yet, not running work', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    expect(resolveFallbackForegroundProcess('/usr/bin/systemd-run', '/bin/bash')).toBeNull()
    expect(resolveFallbackForegroundProcess('env', '/bin/bash')).toBeNull()
    expect(resolveFallbackForegroundProcess('/usr/bin/bash', '/bin/bash')).toBe('bash')
    expect(resolveFallbackForegroundProcess('xterm-256color', '/bin/bash')).toBeNull()
  })

  it('keeps those names elsewhere', () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    expect(resolveFallbackForegroundProcess('env', '/bin/zsh')).toBe('env')
  })
})
