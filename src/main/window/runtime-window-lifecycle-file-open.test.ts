import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeNotifier } from '../runtime/runtime-notifier-contract'

vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), removeListener: vi.fn() } }))
vi.mock('../ipc/worktree-change-invalidators', () => ({ runWorktreeChangeInvalidators: vi.fn() }))
vi.mock('./mobile-markdown-request-relay', () => ({ requestMobileMarkdownFromRenderer: vi.fn() }))
vi.mock('./renderer-document-navigation', () => ({ registerRendererDocumentNavigation: vi.fn() }))
vi.mock('./session-tab-close-request-relay', () => ({
  requestSessionTabCloseFromRenderer: vi.fn()
}))
vi.mock('./terminal-tab-close-request-relay', () => ({
  requestTerminalTabCloseFromRenderer: vi.fn()
}))

import { registerRuntimeWindowLifecycle } from './runtime-window-lifecycle'
import { requestSessionTabCloseFromRenderer } from './session-tab-close-request-relay'

function attachNotifier(): { notifier: RuntimeNotifier; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  const attached: { notifier: RuntimeNotifier | null } = { notifier: null }
  const mainWindow = {
    id: 1,
    isDestroyed: () => false,
    on: vi.fn(),
    webContents: { isDestroyed: () => false, send, on: vi.fn() }
  }
  const runtime = {
    attachWindow: vi.fn(),
    markGraphReloadFailed: vi.fn(),
    setNotifier: (next: RuntimeNotifier | null) => {
      attached.notifier = next
    }
  }
  registerRuntimeWindowLifecycle(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration only reads id, isDestroyed, on and webContents.
    mainWindow as unknown as BrowserWindow,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration only calls the stubbed runtime members.
    runtime as unknown as OrcaRuntimeService
  )
  if (!attached.notifier) {
    throw new Error('runtime notifier was not attached')
  }
  return { notifier: attached.notifier, send }
}

describe('runtime window file-open notifications', () => {
  it('omits navigation when the caller sent none (legacy switch)', () => {
    const { notifier, send } = attachNotifier()

    notifier.openFile?.('wt-1', '/repo/a.ts', 'a.ts', undefined)
    notifier.openDiff?.('wt-1', '/repo/a.ts', 'a.ts', true, undefined)

    expect(send).toHaveBeenCalledWith('ui:openFileFromMobile', {
      worktreeId: 'wt-1',
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      runtimeEnvironmentId: undefined
    })
    expect(send).toHaveBeenCalledWith('ui:openDiffFromMobile', {
      worktreeId: 'wt-1',
      filePath: '/repo/a.ts',
      relativePath: 'a.ts',
      staged: true,
      runtimeEnvironmentId: undefined
    })
    for (const [, payload] of send.mock.calls) {
      expect(payload).not.toHaveProperty('navigation')
    }
  })

  it('forwards an explicit navigation target to the renderer', () => {
    const { notifier, send } = attachNotifier()

    notifier.openFile?.('wt-1', '/repo/a.ts', 'a.ts', undefined, 'all')
    notifier.openDiff?.('wt-1', '/repo/a.ts', 'a.ts', false, undefined, 'caller')

    expect(send).toHaveBeenCalledWith(
      'ui:openFileFromMobile',
      expect.objectContaining({ navigation: 'all' })
    )
    expect(send).toHaveBeenCalledWith(
      'ui:openDiffFromMobile',
      expect.objectContaining({ navigation: 'caller' })
    )
  })
})

describe('runtime window close origin', () => {
  it('skips the relay only for its own trusted origin', async () => {
    vi.mocked(requestSessionTabCloseFromRenderer).mockClear()
    const { notifier } = attachNotifier()
    await notifier.closeSessionTab?.('agent-session:chat', 'wt-1', { originatingWindowId: 1 })
    expect(requestSessionTabCloseFromRenderer).not.toHaveBeenCalled()
  })

  it.each([undefined, { originatingWindowId: 2 }])(
    'keeps independent relay for %j',
    async (options) => {
      vi.mocked(requestSessionTabCloseFromRenderer).mockClear()
      const { notifier } = attachNotifier()
      await notifier.closeSessionTab?.('agent-session:chat', 'wt-1', options)
      expect(requestSessionTabCloseFromRenderer).toHaveBeenCalledOnce()
      expect(requestSessionTabCloseFromRenderer).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1 }),
        'agent-session:chat',
        'wt-1'
      )
    }
  )
})
