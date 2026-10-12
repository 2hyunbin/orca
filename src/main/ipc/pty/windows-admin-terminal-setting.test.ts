import { afterEach, expect, it, vi } from 'vitest'
import type { PtySpawnOptions } from '../../providers/pty-provider-contract'
import { applyAdminPowerShellSetting } from './windows-admin-terminal-setting'

const settings = { terminalWindowsPowerShellAdministrator: true }

afterEach(() => {
  vi.unstubAllGlobals()
})

it.each([
  [undefined, true],
  ['user-resume', false],
  ['automatic-restore', false]
] as const)('spawn intent %s elevates: %s', (spawnIntent, expected) => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  const options: PtySpawnOptions = {
    cols: 80,
    rows: 24,
    shellOverride: 'powershell.exe',
    spawnIntent
  }
  applyAdminPowerShellSetting(options, settings, null)
  expect(options.windowsRunAsAdministrator).toBe(expected)
})
