import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WslResult } from '../wsl/wsl-runner'
import {
  looksLikeWindowsAutocrlfCheckout,
  pendingWslWindowsCheckoutProbe,
  resetWslWindowsCheckoutGitConfigForTests,
  WINDOWS_CHECKOUT_GIT_CONFIG_ARGS,
  withWslWindowsCheckoutGitConfig,
  WSL_WINDOWS_CHECKOUT_RESULT_TTL_MS
} from './wsl-windows-checkout-git-config'

afterEach(() => resetWslWindowsCheckoutGitConfigForTests())

const CWD = String.raw`C:\Users\dev\repo`
const DISTRO = 'Ubuntu'
// Captured from WSL Git 2.53 against a Windows Git (autocrlf=true) clone on C:.
const WINDOWS_CHECKOUT_EOL = [
  'i/lf    w/crlf  attr/                 \t.gitattributes',
  'i/lf    w/crlf  attr/                 \t.gitignore',
  'i/lf    w/crlf  attr/                 \tAGENTS.md',
  'i/-text w/-text attr/                 \tlogo.png',
  ''
].join('\n')
const LINUX_CHECKOUT_EOL = [
  'i/lf    w/lf    attr/                 \t.gitignore',
  'i/lf    w/lf    attr/                 \tREADME.md',
  ''
].join('\n')

function wslResult(overrides: Partial<WslResult>): WslResult {
  return {
    environmentResolved: true,
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides
  }
}

function probeOptions(stdout: string, code = 0) {
  const run = vi.fn(async () => wslResult({ stdout, code }))
  return { run, options: { platform: 'win32' as const, run } }
}

describe('looksLikeWindowsAutocrlfCheckout', () => {
  it('detects LF blobs checked out as CRLF', () => {
    expect(looksLikeWindowsAutocrlfCheckout(WINDOWS_CHECKOUT_EOL)).toBe(true)
  })

  it('ignores an LF checkout', () => {
    expect(looksLikeWindowsAutocrlfCheckout(LINUX_CHECKOUT_EOL)).toBe(false)
  })

  it('needs a majority, so one CRLF file saved into an LF checkout does not count', () => {
    const output = `${LINUX_CHECKOUT_EOL}i/lf    w/crlf  attr/                 \tnotes.txt\n`
    expect(looksLikeWindowsAutocrlfCheckout(output)).toBe(false)
  })

  it('ignores files whose line endings .gitattributes already pins', () => {
    const output = [
      'i/lf    w/crlf  attr/text eol=crlf    \tbuild.cmd',
      'i/lf    w/crlf  attr/text=auto        \tREADME.md',
      ''
    ].join('\n')
    expect(looksLikeWindowsAutocrlfCheckout(output)).toBe(false)
  })

  it('treats empty output as no evidence', () => {
    expect(looksLikeWindowsAutocrlfCheckout('')).toBe(false)
  })
})

describe('Windows checkout config for WSL git', () => {
  it('probes once with argv-safe ls-files and then prepends the config', async () => {
    const { run, options } = probeOptions(WINDOWS_CHECKOUT_EOL)

    await pendingWslWindowsCheckoutProbe(CWD, DISTRO, undefined, options)

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        distro: DISTRO,
        program: 'git',
        args: ['-C', '/mnt/c/Users/dev/repo', 'ls-files', '--eol', '--', ':(top,glob)*'],
        loginPath: 'preferred'
      })
    )
    expect(withWslWindowsCheckoutGitConfig(['status'], CWD, DISTRO, 'win32')).toEqual([
      ...WINDOWS_CHECKOUT_GIT_CONFIG_ARGS,
      'status'
    ])
    expect(pendingWslWindowsCheckoutProbe(CWD, DISTRO, undefined, options)).toBeNull()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('keys the cache case-insensitively by checkout and distro', async () => {
    const { run, options } = probeOptions(WINDOWS_CHECKOUT_EOL)
    await pendingWslWindowsCheckoutProbe(CWD, DISTRO, undefined, options)

    expect(
      withWslWindowsCheckoutGitConfig(['status'], 'c:/users/DEV/repo', 'ubuntu', 'win32')
    ).toEqual([...WINDOWS_CHECKOUT_GIT_CONFIG_ARGS, 'status'])
    expect(withWslWindowsCheckoutGitConfig(['status'], CWD, 'Debian', 'win32')).toEqual(['status'])
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('leaves args alone for an LF checkout or a folder that is not a repository', async () => {
    const lf = probeOptions(LINUX_CHECKOUT_EOL)
    await pendingWslWindowsCheckoutProbe(CWD, DISTRO, undefined, lf.options)
    expect(withWslWindowsCheckoutGitConfig(['status'], CWD, DISTRO, 'win32')).toEqual(['status'])

    const folder = probeOptions('', 128)
    await pendingWslWindowsCheckoutProbe(String.raw`D:\notes`, DISTRO, undefined, folder.options)
    expect(
      pendingWslWindowsCheckoutProbe(String.raw`D:\notes`, DISTRO, undefined, folder.options)
    ).toBeNull()
    expect(folder.run).toHaveBeenCalledTimes(1)
  })

  it('never probes off Windows, without a distro, or for a path inside the distro', () => {
    const { run, options } = probeOptions(WINDOWS_CHECKOUT_EOL)

    expect(
      pendingWslWindowsCheckoutProbe(CWD, DISTRO, undefined, { ...options, platform: 'linux' })
    ).toBeNull()
    expect(pendingWslWindowsCheckoutProbe(CWD, undefined, undefined, options)).toBeNull()
    expect(
      pendingWslWindowsCheckoutProbe(
        String.raw`\\wsl.localhost\Ubuntu\home\dev\repo`,
        DISTRO,
        undefined,
        options
      )
    ).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('shares one in-flight probe between concurrent commands', async () => {
    let finish: (result: WslResult) => void = () => {}
    const run = vi.fn(() => new Promise<WslResult>((resolve) => (finish = resolve)))
    const options = { platform: 'win32' as const, run }

    const first = pendingWslWindowsCheckoutProbe(CWD, DISTRO, undefined, options)
    const second = pendingWslWindowsCheckoutProbe(CWD, DISTRO, undefined, options)
    finish(wslResult({ stdout: WINDOWS_CHECKOUT_EOL }))
    await Promise.all([first, second])

    expect(run).toHaveBeenCalledTimes(1)
  })

  it('stops waiting when the command aborts, without failing it', async () => {
    const run = vi.fn(() => new Promise<WslResult>(() => {}))
    const controller = new AbortController()
    const waiting = pendingWslWindowsCheckoutProbe(CWD, DISTRO, controller.signal, {
      platform: 'win32',
      run
    })
    controller.abort()

    await expect(waiting).resolves.toBeUndefined()
  })

  it('backs off after a timed-out probe instead of retrying on every poll', async () => {
    let now = 1_000
    const run = vi.fn(async () => wslResult({ code: null, timedOut: true }))
    const options = { platform: 'win32' as const, run, now: () => now }

    await pendingWslWindowsCheckoutProbe(CWD, DISTRO, undefined, options)
    expect(pendingWslWindowsCheckoutProbe(CWD, DISTRO, undefined, options)).toBeNull()
    expect(withWslWindowsCheckoutGitConfig(['status'], CWD, DISTRO, 'win32')).toEqual(['status'])

    now += 30_000
    await pendingWslWindowsCheckoutProbe(CWD, DISTRO, undefined, options)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('keeps serving an expired answer while a background refresh runs', async () => {
    let now = 1_000
    const run = vi.fn(async () => wslResult({ stdout: WINDOWS_CHECKOUT_EOL }))
    const options = { platform: 'win32' as const, run, now: () => now }
    await pendingWslWindowsCheckoutProbe(CWD, DISTRO, undefined, options)

    now += WSL_WINDOWS_CHECKOUT_RESULT_TTL_MS + 1
    expect(pendingWslWindowsCheckoutProbe(CWD, DISTRO, undefined, options)).toBeNull()
    expect(withWslWindowsCheckoutGitConfig(['status'], CWD, DISTRO, 'win32')[1]).toBe(
      'core.autocrlf=true'
    )
    expect(run).toHaveBeenCalledTimes(2)
  })
})
