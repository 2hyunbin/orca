import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

import { grantCodexSandboxReadOnManagedHome } from './codex-windows-sandbox-read-grant'

const originalPlatform = process.platform
let home: string

beforeEach(() => {
  runProcessMock.mockReset()
  runProcessMock.mockResolvedValue({
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false
  })
  home = mkdtempSync(join(tmpdir(), 'codex-sandbox-read-grant-'))
  Object.defineProperty(process, 'platform', { value: 'win32' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  rmSync(home, { recursive: true, force: true })
})

describe('grantCodexSandboxReadOnManagedHome', () => {
  it('grants the elevated sandbox group inheritable read once Codex set up that home', async () => {
    await grantCodexSandboxReadOnManagedHome(home)
    expect(runProcessMock).not.toHaveBeenCalled()

    mkdirSync(join(home, '.sandbox'))
    writeFileSync(join(home, '.sandbox', 'setup_marker.json'), '{}')
    await grantCodexSandboxReadOnManagedHome(home)
    await grantCodexSandboxReadOnManagedHome(home)

    expect(runProcessMock).toHaveBeenCalledTimes(2)
    expect(runProcessMock.mock.calls[1][0]).toMatchObject({
      program: expect.stringMatching(/System32[\\/]icacls\.exe$/),
      args: [home, '/grant', 'CodexSandboxUsers:(OI)(CI)RX', '/Q']
    })
  })
  it('skips the tree-wide grant when the home already carries the ACE', async () => {
    mkdirSync(join(home, '.sandbox'))
    writeFileSync(join(home, '.sandbox', 'setup_marker.json'), '{}')
    runProcessMock.mockResolvedValueOnce({
      code: 0,
      signal: null,
      stdout: `${home} PC\\CodexSandboxUsers:(OI)(CI)(RX)\n`,
      stderr: '',
      timedOut: false
    })
    await grantCodexSandboxReadOnManagedHome(home)
    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })
})
