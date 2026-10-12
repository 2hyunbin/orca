import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  pendingWslWindowsCheckoutGitConfig,
  resolveGitCommand,
  resolveGitCommandWithoutProbe
} from './git-command-resolution'
import {
  pendingWslWindowsCheckoutProbe,
  resetWslWindowsCheckoutGitConfigForTests
} from '../wsl-windows-checkout-git-config'
import {
  resetWslLinkedWorktreeGitRoutingForTests,
  seedWslLinkedWorktreeGitRoutingForTests
} from '../wsl-linked-worktree-git-routing'

const originalPlatform = process.platform
const DRIVE_REPO = String.raw`C:\Users\dev\repo`
const CRLF_CHECKOUT = 'i/lf    w/crlf  attr/                 \tREADME.md\n'

async function detectWindowsCheckout(cwd: string): Promise<void> {
  await pendingWslWindowsCheckoutProbe(cwd, 'Ubuntu', undefined, {
    platform: 'win32',
    run: async () => ({
      environmentResolved: true,
      code: 0,
      stdout: CRLF_CHECKOUT,
      stderr: '',
      timedOut: false
    })
  })
}

describe('WSL git on a Windows Git checkout', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    resetWslWindowsCheckoutGitConfigForTests()
    resetWslLinkedWorktreeGitRoutingForTests()
  })

  it('runs WSL git with Windows Git line-ending and stat settings once detected', async () => {
    await detectWindowsCheckout(DRIVE_REPO)

    const resolved = resolveGitCommandWithoutProbe(['status', '--porcelain=v2'], {
      cwd: DRIVE_REPO,
      wslDistro: 'Ubuntu'
    })

    expect(resolved.binary).toBe('wsl.exe')
    expect(resolved.args.join(' ')).toMatch(
      /core\.autocrlf=true.+core\.checkStat=minimal.+core\.trustctime=false.+status/
    )
  })

  it('leaves host-routed commands and undetected checkouts unchanged', async () => {
    expect(
      resolveGitCommandWithoutProbe(['status'], { cwd: DRIVE_REPO, wslDistro: 'Ubuntu' }).args.join(
        ' '
      )
    ).not.toContain('core.autocrlf')

    await detectWindowsCheckout(DRIVE_REPO)
    expect(resolveGitCommand(['status'], { cwd: DRIVE_REPO }).args).toEqual(['status'])

    seedWslLinkedWorktreeGitRoutingForTests(DRIVE_REPO)
    expect(resolveGitCommand(['status'], { cwd: DRIVE_REPO, wslDistro: 'Ubuntu' }).args).toEqual([
      'status'
    ])
    expect(pendingWslWindowsCheckoutGitConfig({ cwd: DRIVE_REPO, wslDistro: 'Ubuntu' })).toBeNull()
  })
})
