import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { glabExecFileAsyncMock } = vi.hoisted(() => ({ glabExecFileAsyncMock: vi.fn() }))

vi.mock('../git/runner', () => ({ glabExecFileAsync: glabExecFileAsyncMock }))

import {
  _getKnownHostsCacheSize,
  _resetKnownHostsCache,
  getGlabKnownHosts,
  KNOWN_HOSTS_CACHE_MAX_ENTRIES,
  rememberGlabKnownHost,
  rememberGlabKnownHosts,
  KNOWN_HOSTS_FAILURE_INITIAL_BACKOFF_MS
} from './gitlab-known-host-probe'

describe('getGlabKnownHosts', () => {
  // A locally-keyed probe must never answer from the default WSL distro.
  const LOCAL_PROBE_OPTIONS = { timeout: 10_000, allowDefaultWslFallback: false }

  afterEach(() => vi.restoreAllMocks())

  beforeEach(() => {
    glabExecFileAsyncMock.mockReset()
    _resetKnownHostsCache()
  })

  it('returns gitlab.com plus auth-status hosts, deduped', async () => {
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: '✓ Logged in to gitlab.com as user\n✓ Logged in to gitlab.example.com as user\n',
      stderr: ''
    })

    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com', 'gitlab.example.com'])
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(['auth', 'status'], LOCAL_PROBE_OPTIONS)
  })

  it('preserves WSL and background admission on the cold auth-status probe', async () => {
    glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await getGlabKnownHosts(undefined, {
      wslDistro: 'Ubuntu',
      admissionTier: 'background'
    })

    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(['auth', 'status'], {
      ...LOCAL_PROBE_OPTIONS,
      wslDistro: 'Ubuntu',
      admissionTier: 'background'
    })
  })

  it('falls back to default when glab auth status fails', async () => {
    glabExecFileAsyncMock.mockRejectedValueOnce(new Error('glab not authenticated'))

    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com'])
  })

  it.each([
    { connectionId: undefined, options: {}, host: 'native.test' },
    { connectionId: undefined, options: { wslDistro: 'Ubuntu' }, host: 'ubuntu.test' },
    { connectionId: undefined, options: { wslDistro: 'Debian' }, host: 'debian.test' },
    { connectionId: 'conn-1', options: {}, host: 'ssh.test' }
  ])('caches only successful logins from partial auth failure for $host', async (context) => {
    // Mirrors glab v1.67.0 auth/status: host blocks on stderr, then an aggregate failure.
    glabExecFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('glab auth status exited with code 1'), {
        stdout: '',
        stderr: `${context.host}:8443
  ✓ Logged in to ${context.host}:8443 as user (config file)
  ✓ Git operations for ${context.host}:8443 configured to use ssh protocol.
  ✓ Token found: **************************
gitlab.com
  ✗ gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: 401 {message: 401 Unauthorized}
  ✓ Token found: **************************
gitlab.failed.test
  ✗ gitlab.failed.test: failed to initialize api client: no token configured
  ! No token found (checked config file, keyring, and environment variables).

✗ could not authenticate to one or more of the configured GitLab instances.
`
      })
    )

    const expected = ['gitlab.com', `${context.host}:8443`]
    await expect(getGlabKnownHosts(context.connectionId, context.options)).resolves.toEqual(
      expected
    )
    await expect(getGlabKnownHosts(context.connectionId, context.options)).resolves.toEqual(
      expected
    )
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(1)

    glabExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })
    const otherConnection = context.connectionId ? undefined : 'conn-other'
    await expect(getGlabKnownHosts(otherConnection)).resolves.toEqual(['gitlab.com'])
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed self-managed host when only gitlab.com logged in', async () => {
    glabExecFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('glab auth status exited with code 1'), {
        stdout: `gitlab.com
  ✓ Logged in to gitlab.com as user (config file)
  ✓ Token found: **************************
`,
        stderr: `gitlab.failed.test
  ✗ gitlab.failed.test: API call failed: GET https://gitlab.failed.test/api/v4/user: 401 {message: 401 Unauthorized}
  ✓ Git operations for gitlab.failed.test configured to use ssh protocol.
  ✓ Token found: **************************

✗ could not authenticate to one or more of the configured GitLab instances.
`
      })
    )

    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com'])
    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com'])
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('keeps modern glab login results with killed=%s', async (killed) => {
    // Mirrors glab v1.124.0, including forced color and CRLF output.
    const stderr = `\u001b[1mgitlab.example.com\u001b[0m
  \u001b[32m✓\u001b[0m Logged in to gitlab.example.com as user (keyring)
  ✓ Token found in operating system keyring: **************************
gitlab.failed.test
  ✗ gitlab.failed.test: API call failed: GET https://gitlab.failed.test/api/v4/user: 401 {message: 401 Unauthorized}
  ✓ Token found in configuration file (plaintext): **************************
  ! To store this token more securely, run glab auth login --hostname gitlab.failed.test to move it into the operating system keyring.
`.replaceAll('\n', '\r\n')
    glabExecFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('glab auth status failed'), { stdout: '', stderr, killed })
    )

    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com', 'gitlab.example.com'])
    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com', 'gitlab.example.com'])
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('backs off with no successful logins and does not parse login advice as a host', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    glabExecFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('glab auth status exited with code 1'), {
        stdout: '',
        stderr: `gitlab.failed.test
  ✗ gitlab.failed.test: API call failed: GET https://gitlab.failed.test/api/v4/user: 403 {message: You must be logged in to perform this action}
  ✓ Token found: **************************
`
      })
    )

    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com'])
    clock.mockReturnValue(1_000 + KNOWN_HOSTS_FAILURE_INITIAL_BACKOFF_MS - 1)
    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com'])
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(1)
    clock.mockReturnValue(1_000 + KNOWN_HOSTS_FAILURE_INITIAL_BACKOFF_MS)
    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com'])
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('caches the result across calls', async () => {
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: '✓ Logged in to gitlab.com as user\n',
      stderr: ''
    })

    await getGlabKnownHosts()
    await getGlabKnownHosts()
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('coalesces many simultaneous callers in one execution context', async () => {
    let resolveProbe!: (value: { stdout: string; stderr: string }) => void
    glabExecFileAsyncMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve
        })
    )

    const probes = Array.from({ length: 64 }, () => getGlabKnownHosts())

    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(1)
    resolveProbe({ stdout: 'Logged in to gitlab.concurrent.test as user\n', stderr: '' })
    const results = await Promise.all(probes)
    expect(results.every((result) => result === results[0])).toBe(true)
    expect(results[0]).toEqual(['gitlab.com', 'gitlab.concurrent.test'])
  })

  it('keeps simultaneous native, WSL distro, and connection probes isolated', async () => {
    glabExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'Logged in to ubuntu.test as user\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Logged in to debian.test as user\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Logged in to native.test as user\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Logged in to ssh.test as user\n', stderr: '' })

    const [ubuntu, ubuntuAgain, debian, native, ssh] = await Promise.all([
      getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' }),
      getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' }),
      getGlabKnownHosts(undefined, { wslDistro: 'Debian' }),
      getGlabKnownHosts(),
      getGlabKnownHosts('conn-1')
    ])

    expect(ubuntuAgain).toBe(ubuntu)
    expect(ubuntu).toEqual(['gitlab.com', 'ubuntu.test'])
    expect(debian).toEqual(['gitlab.com', 'debian.test'])
    expect(native).toEqual(['gitlab.com', 'native.test'])
    expect(ssh).toEqual(['gitlab.com', 'ssh.test'])
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(4)
    expect(glabExecFileAsyncMock).toHaveBeenNthCalledWith(1, ['auth', 'status'], {
      ...LOCAL_PROBE_OPTIONS,
      wslDistro: 'Ubuntu'
    })
    expect(glabExecFileAsyncMock).toHaveBeenNthCalledWith(2, ['auth', 'status'], {
      ...LOCAL_PROBE_OPTIONS,
      wslDistro: 'Debian'
    })
  })

  it('preserves a native auth refresh while an older native probe is in flight', async () => {
    let resolveProbe!: (value: { stdout: string; stderr: string }) => void
    glabExecFileAsyncMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve
        })
    )

    const staleProbe = getGlabKnownHosts()
    rememberGlabKnownHost('gitlab.refreshed.test')
    resolveProbe({ stdout: 'Logged in to gitlab.com as user\n', stderr: '' })

    await expect(staleProbe).resolves.toEqual(['gitlab.com', 'gitlab.refreshed.test'])
    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com', 'gitlab.refreshed.test'])
  })

  it('preserves a native auth refresh when an older native probe fails', async () => {
    let rejectProbe!: (error: Error) => void
    glabExecFileAsyncMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectProbe = reject
        })
    )

    const staleProbe = getGlabKnownHosts()
    rememberGlabKnownHost('gitlab.refreshed.test')
    rejectProbe(new Error('stale auth probe failed'))

    await expect(staleProbe).resolves.toEqual(['gitlab.com', 'gitlab.refreshed.test'])
    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com', 'gitlab.refreshed.test'])
  })

  it('keeps a remembered native host out of WSL and SSH caches', async () => {
    glabExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'Logged in to native.test as user\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Logged in to wsl.test as user\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'Logged in to ssh.test as user\n', stderr: '' })

    await Promise.all([
      getGlabKnownHosts(),
      getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' }),
      getGlabKnownHosts('conn-1')
    ])
    rememberGlabKnownHost('gitlab.refreshed.test')

    await expect(getGlabKnownHosts()).resolves.toEqual([
      'gitlab.com',
      'native.test',
      'gitlab.refreshed.test'
    ])
    await expect(getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' })).resolves.toEqual([
      'gitlab.com',
      'wsl.test'
    ])
    await expect(getGlabKnownHosts('conn-1')).resolves.toEqual(['gitlab.com', 'ssh.test'])
  })

  it('batch-normalizes and deduplicates hosts in first-seen order per execution context', async () => {
    rememberGlabKnownHosts([' Native-B.test ', 'native-a.test', 'NATIVE-B.TEST'])
    rememberGlabKnownHosts(['WSL-B.test', ' wsl-a.test ', 'wsl-b.test'], undefined, {
      wslDistro: 'Ubuntu'
    })
    rememberGlabKnownHosts(['SSH-B.test', 'ssh-a.test', ' ssh-b.test '], 'conn-batch')

    await expect(getGlabKnownHosts()).resolves.toEqual([
      'gitlab.com',
      'native-b.test',
      'native-a.test'
    ])
    await expect(getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' })).resolves.toEqual([
      'gitlab.com',
      'wsl-b.test',
      'wsl-a.test'
    ])
    await expect(getGlabKnownHosts('conn-batch')).resolves.toEqual([
      'gitlab.com',
      'ssh-b.test',
      'ssh-a.test'
    ])
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('bounds execution-context cache keys across SSH reconnect churn', () => {
    for (let index = 0; index < KNOWN_HOSTS_CACHE_MAX_ENTRIES + 20; index += 1) {
      rememberGlabKnownHost(`host-${index}.example`, `connection-${index}`)
    }

    expect(_getKnownHostsCacheSize()).toBe(KNOWN_HOSTS_CACHE_MAX_ENTRIES)
  })

  it('recognizes a self-hosted host on a non-default port', async () => {
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: '✓ Logged in to gitlab.example.com:8080 as user\n',
      stderr: ''
    })

    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com', 'gitlab.example.com:8080'])
  })

  it('caches per connection — the local probe does not satisfy a connection probe', async () => {
    glabExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '✓ Logged in to gitlab.com as user\n', stderr: '' })
      .mockResolvedValueOnce({
        stdout: '✓ Logged in to gitlab.example.com:8080 as user\n',
        stderr: ''
      })

    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com'])
    await expect(getGlabKnownHosts('conn-1')).resolves.toEqual([
      'gitlab.com',
      'gitlab.example.com:8080'
    ])
    await expect(getGlabKnownHosts('conn-1')).resolves.toEqual([
      'gitlab.com',
      'gitlab.example.com:8080'
    ])
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('does not permanently cache the failure fallback — a later probe can re-discover hosts', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    glabExecFileAsyncMock
      .mockRejectedValueOnce(new Error('ssh tunnel not ready'))
      .mockResolvedValueOnce({
        stdout: '✓ Logged in to gitlab.example.com:8080 as user\n',
        stderr: ''
      })

    // Failed probes only back off briefly so recovery can discover the actual host.
    await expect(getGlabKnownHosts('conn-1')).resolves.toEqual(['gitlab.com'])
    clock.mockReturnValue(1_000 + KNOWN_HOSTS_FAILURE_INITIAL_BACKOFF_MS)
    await expect(getGlabKnownHosts('conn-1')).resolves.toEqual([
      'gitlab.com',
      'gitlab.example.com:8080'
    ])
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('removes a timed-out probe from in-flight state so a later call retries', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    let rejectProbe!: (error: Error) => void
    glabExecFileAsyncMock
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectProbe = reject
          })
      )
      .mockResolvedValueOnce({ stdout: 'Logged in to recovered.test as user\n', stderr: '' })

    const first = getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' })
    const concurrent = getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' })
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(1)
    rejectProbe(new Error('wsl.exe timed out.'))

    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      ['gitlab.com'],
      ['gitlab.com']
    ])
    clock.mockReturnValue(1_000 + KNOWN_HOSTS_FAILURE_INITIAL_BACKOFF_MS)
    await expect(getGlabKnownHosts(undefined, { wslDistro: 'Ubuntu' })).resolves.toEqual([
      'gitlab.com',
      'recovered.test'
    ])
    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })
})
