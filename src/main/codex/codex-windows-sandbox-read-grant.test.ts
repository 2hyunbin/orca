import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

import { grantCodexSandboxReadOnManagedHome } from './codex-windows-sandbox-read-grant'

const originalPlatform = process.platform
let home: string

function processResult(code: number, stdout = '') {
  return { code, signal: null, stdout, stderr: '', timedOut: false }
}

function grantCalls(): string[] {
  return runProcessMock.mock.calls
    .map(([spec]) => spec.args)
    .filter((args: string[]) => args[1] === '/grant')
    .map((args: string[]) => args[0])
}

beforeEach(() => {
  runProcessMock.mockReset()
  runProcessMock.mockResolvedValue(processResult(0))
  home = mkdtempSync(join(tmpdir(), 'codex-sandbox-read-grant-'))
  mkdirSync(join(home, '.sandbox'))
  writeFileSync(join(home, '.sandbox', 'setup_marker.json'), '{}')
  Object.defineProperty(process, 'platform', { value: 'win32' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  rmSync(home, { recursive: true, force: true })
})

describe('grantCodexSandboxReadOnManagedHome', () => {
  it('grants the sandbox group read on the resource folders, never the home root', async () => {
    mkdirSync(join(home, 'skills'))

    await grantCodexSandboxReadOnManagedHome(home)
    await grantCodexSandboxReadOnManagedHome(home)

    expect(existsSync(join(home, 'generated_images'))).toBe(true)
    expect(grantCalls().sort()).toEqual([join(home, 'generated_images'), join(home, 'skills')])
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: expect.stringMatching(/System32[\\/]icacls\.exe$/),
        args: [join(home, 'skills'), '/grant', 'CodexSandboxUsers:(OI)(CI)RX', '/Q']
      })
    )
  })

  it('retries a failed grant on the next launch', async () => {
    runProcessMock.mockImplementation(async ({ args }) =>
      args[1] === '/grant' ? processResult(1332) : processResult(0)
    )
    await grantCodexSandboxReadOnManagedHome(home)
    runProcessMock.mockResolvedValue(processResult(0))
    await grantCodexSandboxReadOnManagedHome(home)

    expect(grantCalls()).toEqual([join(home, 'generated_images'), join(home, 'generated_images')])
  })

  it('does nothing before Codex set up its elevated sandbox for the home', async () => {
    rmSync(join(home, '.sandbox'), { recursive: true })
    await grantCodexSandboxReadOnManagedHome(home)
    expect(runProcessMock).not.toHaveBeenCalled()
  })
})
