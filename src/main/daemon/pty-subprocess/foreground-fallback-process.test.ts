import { afterEach, describe, expect, it } from 'vitest'
import { resolveFallbackForegroundProcess } from './foreground-fallback-process'
import { setTerminalScopesForTest } from '../terminal-scopes-runtime'

describe('resolveFallbackForegroundProcess', () => {
  afterEach(() => setTerminalScopesForTest(null))

  it('reads the terminal scope wrappers as no foreground yet, but a user-typed systemd-run as work', () => {
    setTerminalScopesForTest({
      slice: 'orca_ptys_a.slice',
      sliceCgroupPath: '/sys/fs/cgroup/x/orca_ptys_a.slice',
      systemdRun: '/usr/bin/systemd-run',
      envBinary: '/usr/bin/env',
      launchId: 'a',
      properties: []
    })
    // node-pty on Linux reports the foreground group leader's argv[0].
    expect(resolveFallbackForegroundProcess('/usr/bin/systemd-run', '/bin/bash')).toBeNull()
    expect(resolveFallbackForegroundProcess('/usr/bin/env', '/bin/bash')).toBeNull()
    expect(resolveFallbackForegroundProcess('systemd-run', '/bin/bash')).toBe('systemd-run')
    expect(resolveFallbackForegroundProcess('/usr/bin/bash', '/bin/bash')).toBe('bash')
  })

  it('keeps every name while terminal scopes are off', () => {
    expect(resolveFallbackForegroundProcess('/usr/bin/systemd-run', '/bin/zsh')).toBe('systemd-run')
  })
})
