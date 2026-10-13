import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromises from 'node:fs/promises'

const { realpath, open, handle } = vi.hoisted(() => {
  const stats = { size: 5, dev: 1, ino: 1, nlink: 1, isFile: () => true }
  const handle = {
    stat: vi.fn(async () => stats),
    close: vi.fn(async () => {}),
    read: vi.fn(async (target: Buffer, offset: number, length: number, position: number) => {
      const bytes = Buffer.from('IMAGE')
      const bytesRead = Math.min(length, bytes.length - position)
      bytes.copy(target, offset, position, position + bytesRead)
      return { bytesRead, buffer: target }
    })
  }
  return {
    realpath: vi.fn(async (path: string) => path),
    open: vi.fn(async () => handle),
    handle
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    realpath,
    open,
    lstat: async () => ({ size: 5, dev: 1, ino: 1, nlink: 1, isFile: () => true })
  }
})

import { readTerminalKittyFile } from './terminal-kitty-file-read'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  realpath.mockImplementation(async (path: string) => path)
})
afterEach(() => vi.unstubAllGlobals())

const OWNER = { workspacePath: 'C:\\repo', wslDistro: 'Ubuntu' }
const ROOT = '\\\\wsl.localhost\\Ubuntu'

describe('authoritative WSL Kitty file roots', () => {
  it('allows guest /tmp for a WSL PTY with a native Windows workspace', async () => {
    await expect(readTerminalKittyFile({ path: '/tmp/claude-image' }, OWNER)).resolves.toEqual({
      base64: 'SU1BR0U='
    })
    expect(open).toHaveBeenCalledWith(`${ROOT}\\tmp\\claude-image`, expect.any(Number))
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('maps the native workspace into that same guest namespace', async () => {
    await expect(readTerminalKittyFile({ path: '/mnt/c/repo/image' }, OWNER)).resolves.toEqual({
      base64: 'SU1BR0U='
    })
    expect(realpath).toHaveBeenCalledWith(`${ROOT}\\mnt\\c\\repo`)
    expect(open).toHaveBeenCalledWith(`${ROOT}\\mnt\\c\\repo\\image`, expect.any(Number))
  })

  it('uses the PTY distro rather than an old workspace UNC distro', async () => {
    const owner = { workspacePath: '\\\\wsl.localhost\\Debian\\repo', wslDistro: 'Ubuntu' }
    await expect(readTerminalKittyFile({ path: '/tmp/claude-image' }, owner)).resolves.toEqual({
      base64: 'SU1BR0U='
    })
    expect(realpath).toHaveBeenCalledWith(`${ROOT}\\repo`)
    expect(open).toHaveBeenCalledWith(`${ROOT}\\tmp\\claude-image`, expect.any(Number))
  })

  it('does not fold case in a WSL Linux directory name', async () => {
    const owner = { workspacePath: `${ROOT}\\repo`, wslDistro: 'Ubuntu' }
    await expect(readTerminalKittyFile({ path: '/Repo/image' }, owner)).rejects.toThrow(
      'outside this terminal'
    )
    expect(open).not.toHaveBeenCalled()
  })

  it('does not fold equivalent Unicode names into a WSL root', async () => {
    const owner = { workspacePath: `${ROOT}\\é`, wslDistro: 'Ubuntu' }
    await expect(readTerminalKittyFile({ path: '/e\u0301/image' }, owner)).rejects.toThrow(
      'outside this terminal'
    )
    expect(open).not.toHaveBeenCalled()
  })

  it('does not authorize a distinct Unicode sibling of a native root', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    const owner = { workspacePath: '/srv/é', wslDistro: null }
    await expect(readTerminalKittyFile({ path: '/srv/e\u0301/image' }, owner)).rejects.toThrow(
      'outside this terminal'
    )
    expect(open).not.toHaveBeenCalled()
  })

  it('rejects a canonical target in a different distro before opening', async () => {
    realpath.mockImplementation(async (path: string) =>
      path.endsWith('claude-image') ? '\\\\wsl.localhost\\Debian\\tmp\\claude-image' : path
    )
    await expect(readTerminalKittyFile({ path: '/tmp/claude-image' }, OWNER)).rejects.toThrow(
      'outside this terminal'
    )
    expect(open).not.toHaveBeenCalled()
  })
})
