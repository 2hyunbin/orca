import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import {
  launchExternalEditor,
  resolveVsCodeRemoteSshLaunchSpec,
  type ExternalEditorLaunchSpec
} from './external-editor-launch'

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function spawnedChild(): { once: unknown; off: unknown; unref: unknown } {
  const child = {
    once: vi.fn((eventName: string, callback: () => void) => {
      if (eventName === 'spawn') {
        queueMicrotask(callback)
      }
      return child
    }),
    off: vi.fn(() => child),
    unref: vi.fn()
  }
  return child
}

function remoteSpec(
  code: string,
  path: string,
  platform: NodeJS.Platform
): ExternalEditorLaunchSpec {
  const spec = resolveVsCodeRemoteSshLaunchSpec(code, path, 'builder', {
    platform,
    fileExists: () => true
  })
  if (!spec) {
    throw new Error('expected a VS Code launch spec')
  }
  return spec
}

const HIDDEN = expect.objectContaining({
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
  shell: false
})

describe('VS Code Remote-SSH launch through @orca/process-host', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(spawnedChild)
  })

  afterEach(() => {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  it.each([
    ['darwin', '/usr/local/bin/code'],
    ['linux', '/usr/bin/code']
  ] as const)(
    'starts code directly on %s with a hidden, detached child',
    async (platform, code) => {
      setPlatform(platform)
      await launchExternalEditor(remoteSpec(code, '/home/ada/my project', platform))
      expect(spawnMock).toHaveBeenCalledWith(
        code,
        ['--remote', 'ssh-remote+builder', '/home/ada/my project'],
        HIDDEN
      )
    }
  )

  it('starts a Windows code.cmd through cmd.exe without a console window', async () => {
    setPlatform('win32')
    const codeCmd = 'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd'
    await launchExternalEditor(remoteSpec(codeCmd, '/home/ada/project', 'win32'))
    expect(spawnMock).toHaveBeenCalledWith(
      expect.stringMatching(/cmd\.exe$/i),
      ['/d', '/c', codeCmd, '--remote', 'ssh-remote+builder', '/home/ada/project'],
      HIDDEN
    )
  })

  it('refuses a remote path cmd.exe would reparse before starting anything', async () => {
    setPlatform('win32')
    const spec = remoteSpec('C:\\Tools\\code.cmd', '/srv/project&whoami', 'win32')
    await expect(launchExternalEditor(spec)).rejects.toThrow()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('keeps the console of a Windows terminal editor visible', async () => {
    setPlatform('win32')
    await launchExternalEditor({
      kind: 'executable',
      hideWindowsConsole: false,
      spawnCmd: 'C:\\Tools\\nvim.exe',
      spawnArgs: ['C:\\work']
    })
    expect(spawnMock).toHaveBeenCalledWith('C:\\Tools\\nvim.exe', ['C:\\work'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    })
  })
})
