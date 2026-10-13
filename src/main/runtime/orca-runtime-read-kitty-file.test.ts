import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }))
vi.mock('./terminal-kitty-file-read', () => ({ readTerminalKittyFile: readFile }))

const PTY = 'kitty-file-pty'
const LEAF = '11111111-1111-4111-8111-111111111111'
const WORKSPACE = 'folder:kitty-files'

function fixture(ptyId = PTY, connectionId: string | null = null) {
  const runtime = new OrcaRuntimeService(null)
  runtime.attachWindow(1)
  const handle = runtime.preAllocateHandleForPty(ptyId)
  runtime.registerPty(ptyId, WORKSPACE, connectionId, {
    tabId: 'file-tab',
    leafId: LEAF,
    incarnationId: 'file-incarnation'
  })
  runtime.syncWindowGraph(1, {
    tabs: [
      { tabId: 'file-tab', worktreeId: WORKSPACE, title: '', activeLeafId: LEAF, layout: null }
    ],
    leaves: [{ tabId: 'file-tab', worktreeId: WORKSPACE, leafId: LEAF, paneRuntimeId: 1, ptyId }]
  })
  runtime['resolveWorktreeSelector'] = vi.fn().mockResolvedValue({ path: '/workspace' })
  return { runtime, handle }
}

beforeEach(() => {
  readFile.mockReset().mockResolvedValue({ base64: 'aW1hZ2U=' })
})

describe('Kitty file execution-host ownership', () => {
  it('resolves folder workspace and passes the recorded WSL namespace', async () => {
    const { runtime, handle } = fixture()
    runtime.preparePtyExecutionContext(PTY, 'Ubuntu')
    const request = { path: '/tmp/image', offset: 2, length: 3 }
    const controller = new AbortController()
    expect(await runtime.readKittyFile(handle, request, controller.signal)).toEqual({
      base64: 'aW1hZ2U='
    })
    expect(runtime['resolveWorktreeSelector']).toHaveBeenCalledWith(`id:${WORKSPACE}`)
    expect(readFile).toHaveBeenCalledWith(
      request,
      { workspacePath: '/workspace', wslDistro: 'Ubuntu' },
      controller.signal
    )
  })

  it('rejects a foreign PTY without opening a same-named client file', async () => {
    const { runtime, handle } = fixture('ssh:target@@file-pty', 'target')
    await expect(runtime.readKittyFile(handle, { path: '/tmp/image' })).rejects.toThrow(
      'execution host'
    )
    expect(readFile).not.toHaveBeenCalled()
  })

  it('rejects a wrong expected incarnation before reading', async () => {
    const { runtime, handle } = fixture()
    await expect(
      runtime.readKittyFile(handle, {
        path: '/tmp/image',
        expectedIncarnationId: 'older-incarnation'
      })
    ).rejects.toThrow('terminal_handle_stale')
    expect(readFile).not.toHaveBeenCalled()
  })

  it('drops a completed read after the PTY incarnation is replaced', async () => {
    const { runtime, handle } = fixture()
    let release: (result: { base64: string }) => void = () => {
      throw new Error('read did not start')
    }
    readFile.mockImplementation(
      () =>
        new Promise<{ base64: string }>((resolve) => {
          release = resolve
        })
    )
    const pending = runtime.readKittyFile(handle, { path: '/tmp/image' })
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledOnce())
    runtime.registerPty(PTY, WORKSPACE, null, {
      tabId: 'file-tab',
      leafId: LEAF,
      incarnationId: 'new-incarnation'
    })
    release({ base64: 'c3RhbGU=' })
    await expect(pending).rejects.toThrow('terminal_handle_stale')
  })

  it('does not read a missing or stale terminal handle', async () => {
    const { runtime } = fixture()
    await expect(runtime.readKittyFile('term_missing', { path: '/tmp/image' })).rejects.toThrow()
    expect(readFile).not.toHaveBeenCalled()
  })
})
