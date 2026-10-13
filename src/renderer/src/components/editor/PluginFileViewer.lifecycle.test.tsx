// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createEditorTabsStore } from '@/store/slices/editor-slice-test-harness'
import type { AppState } from '@/store/types'
import type { OpenFile } from '@/store/slices/editor'
import type { PluginViewerStatus } from '../../../../shared/plugins/plugin-viewer-frame-protocol'
import type {
  PluginViewerGuestLease,
  PluginViewerOpenResponse
} from '../../../../shared/plugins/plugin-viewer-open'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn(),
  subscribe: vi.fn(),
  open: vi.fn(),
  close: vi.fn(),
  attach: vi.fn(),
  assertCurrent: vi.fn(),
  capture: vi.fn(),
  context: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/store', () => ({
  useAppStore: { getState: mocks.getState, setState: mocks.setState, subscribe: mocks.subscribe }
}))
vi.mock('@/lib/editor-file-operation-owner', () => ({
  assertEditorFileOperationCurrent: mocks.assertCurrent,
  captureEditorFileOperationProvenance: mocks.capture,
  getEditorFileOperationContext: mocks.context
}))
vi.mock('@/lib/local-file-access', () => ({ editorTabFileAccess: vi.fn() }))
vi.mock('@/hooks/use-document-dark-theme', () => ({ useDocumentDarkTheme: () => false }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./plugin-viewer-webview', () => ({ attachPluginViewerWebview: mocks.attach }))
vi.mock('./PluginFileViewerPicker', () => ({ PluginFileViewerPicker: () => null }))

import { PluginFileViewer } from './PluginFileViewer'

const file: OpenFile = {
  id: 'viewer-tab',
  filePath: '/repo/file.binary',
  relativePath: 'file.binary',
  worktreeId: 'wt-1',
  runtimeEnvironmentId: null,
  mode: 'plugin-viewer',
  language: 'plaintext',
  isDirty: false,
  readOnly: true,
  pluginViewer: { key: 'viewer:community.viewer/sample', sourceView: { readOnly: false } }
}
const lease: PluginViewerGuestLease = {
  id: '11111111-1111-4111-8111-111111111111',
  partition: 'orca-viewer-private-1',
  url: 'orca-plugin-viewer://11111111-1111-4111-8111-111111111111/'
}
let root: Root
let container: HTMLDivElement
let store: ReturnType<typeof createEditorTabsStore>
let detach: Mock<() => void>
let receive: (status: PluginViewerStatus) => void
let stopWatch: Mock<() => void>
function deferredOpen() {
  let resolve!: (result: PluginViewerOpenResponse) => void
  const promise = new Promise<PluginViewerOpenResponse>((done) => {
    resolve = done
  })
  mocks.open.mockReturnValue(promise)
  return resolve
}
async function mount(input = file): Promise<void> {
  await act(async () => root.render(<PluginFileViewer file={input} scopeId="pane-1" />))
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { plugins: { openViewerTab: mocks.open, closeViewerTab: mocks.close } }
  })
  store = createEditorTabsStore()
  store.setState({ openFiles: [file] })
  mocks.getState.mockImplementation(store.getState)
  mocks.setState.mockImplementation(store.setState)
  stopWatch = vi.fn()
  mocks.subscribe.mockImplementation((listener: (state: AppState) => void) => {
    const unsubscribe = store.subscribe(listener)
    return () => {
      stopWatch()
      unsubscribe()
    }
  })
  mocks.capture.mockReturnValue({ generation: { route: { executionHostId: 'local' } } })
  mocks.context.mockReturnValue({ expectedExecutionHostId: 'local' })
  mocks.assertCurrent.mockImplementation((current: AppState) => {
    if (!current.worktreesByRepo['repo-1']?.length) {
      throw new Error('owner withdrawn')
    }
    return { executionHostId: 'local', runtimeEnvironmentId: null }
  })
  mocks.open.mockResolvedValue({ ok: true, lease })
  mocks.close.mockResolvedValue(undefined)
  detach = vi.fn()
  mocks.attach.mockImplementation((input: { onStatus(status: PluginViewerStatus): void }) => {
    receive = input.onStatus
    return detach
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('file viewer admission and cleanup', () => {
  it.each([true, false])(
    'uses freshly captured ownership for restored selected intent %s',
    async (selected) => {
      const restored: OpenFile = {
        ...file,
        relativePath: file.filePath,
        runtimeEnvironmentId: 'managed',
        pluginViewerUserSelectedFile: selected ? true : undefined,
        operationProvenance: undefined
      }
      store.setState({
        openFiles: [restored],
        runtimeStatusByEnvironmentId: new Map(),
        runtimeEnvironments: [
          {
            id: 'managed',
            name: 'Managed host',
            runtimeId: 'verified-server',
            createdAt: 1,
            updatedAt: 1,
            pairingRevision: 2,
            lastUsedAt: null,
            endpoints: [],
            preferredEndpointId: 'ws'
          }
        ]
      })
      mocks.capture.mockReturnValue({
        ownershipProjection: 'explicit',
        generation: {
          route: { executionHostId: 'runtime:managed', runtimeEnvironmentId: 'managed' },
          runtimePairingRevision: 2,
          runtimeConnectionGeneration: null,
          runtimeSshGeneration: null,
          nestedSshGeneration: null,
          directSshGeneration: null
        }
      })
      mocks.assertCurrent.mockReturnValue({
        executionHostId: 'runtime:managed',
        runtimeEnvironmentId: 'managed'
      })
      await mount(restored)
      expect(mocks.open).toHaveBeenCalledWith(
        expect.objectContaining({
          executionHostId: 'runtime:managed',
          expectedEnvironmentPairingRevision: 2,
          expectedEnvironmentRuntimeId: 'verified-server',
          access: selected ? { kind: 'user-file' } : undefined
        })
      )
      expect(store.getState().openFiles[0]?.operationProvenance).toBeUndefined()
      await act(async () =>
        receive({ type: 'ready', viewport: { kind: 'text', startLine: 0, lineCount: 64 } })
      )
      expect(store.getState().openFiles[0]?.operationProvenance).toEqual(
        mocks.capture.mock.results[0]?.value
      )
    }
  )
  it('closes an admitted lease exactly once when the pane disappears before admission finishes', async () => {
    const resolve = deferredOpen()
    await mount()
    await act(async () => root.render(null))
    await act(async () => resolve({ ok: true, lease }))
    expect(mocks.attach).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith(lease)
  })
  it('closes a late lease after ownership withdrawal and ignores late ready events', async () => {
    const resolve = deferredOpen()
    await mount()
    await act(async () => store.setState({ worktreesByRepo: {} }))
    expect(container.textContent).toContain('access has ended')
    expect(container.querySelector('[role="alert"] button')).toBeNull()
    await act(async () => resolve({ ok: true, lease }))
    expect(mocks.attach).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith(lease)
  })
  it('retires a failed guest once and prevents late status from changing the error or viewport', async () => {
    await mount()
    await act(async () => receive({ type: 'error', code: 'unresponsive' }))
    expect(container.textContent).toContain('stopped responding')
    await act(async () => {
      receive({ type: 'ready', viewport: { kind: 'text', startLine: 64, lineCount: 64 } })
      receive({ type: 'error', code: 'invalid_output' })
      root.render(null)
    })
    expect(detach).toHaveBeenCalledOnce()
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith(lease)
    expect(store.getState().openFiles[0]?.pluginViewer?.viewport).toBeUndefined()
  })
  it('rechecks ownership after admission even if the host event has not published a store update', async () => {
    const resolve = deferredOpen()
    await mount()
    mocks.assertCurrent.mockImplementation(() => {
      throw new Error('new connection generation')
    })
    await act(async () => resolve({ ok: true, lease }))
    expect(mocks.attach).not.toHaveBeenCalled()
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith(lease)
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(container.textContent).toContain('access has ended')
  })
  it('handles failure during attachment without leaking the returned guest cleanup', async () => {
    mocks.attach.mockImplementation((input: { onStatus(status: PluginViewerStatus): void }) => {
      input.onStatus({ type: 'error', code: 'unavailable' })
      return detach
    })
    await mount()
    await act(async () => root.render(null))
    expect(detach).toHaveBeenCalledOnce()
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith(lease)
  })
  it('retries a failed parser with a new lease and preserves the host-owned viewport', async () => {
    await mount()
    const viewport = { kind: 'text' as const, startLine: 64, lineCount: 64 }
    await act(async () => receive({ type: 'ready', viewport }))
    const current = store.getState().openFiles[0]!
    await mount(current)
    await act(async () => receive({ type: 'error', code: 'parse_failed' }))
    const nextLease = {
      id: '22222222-2222-4222-8222-222222222222',
      partition: 'orca-viewer-private-2',
      url: 'orca-plugin-viewer://22222222-2222-4222-8222-222222222222/'
    }
    mocks.open.mockResolvedValue({ ok: true, lease: nextLease })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[role="alert"] button')?.click()
    })
    expect(mocks.open).toHaveBeenCalledTimes(2)
    expect(mocks.open.mock.calls[1]?.[0].chrome.viewport).toEqual(viewport)
    expect(mocks.attach.mock.calls[1]?.[0].lease).toEqual(nextLease)
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith(lease)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
  it('rejects a runtime owner missing from the current catalog before any admission RPC', async () => {
    store.setState({ runtimeEnvironments: [], runtimeStatusByEnvironmentId: new Map() })
    mocks.assertCurrent.mockReturnValue({
      executionHostId: 'runtime:remote-runtime',
      runtimeEnvironmentId: 'remote-runtime'
    })
    await mount({ ...file, runtimeEnvironmentId: 'remote-runtime' })
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.attach).not.toHaveBeenCalled()
    expect(container.textContent).toContain('access has ended')
  })
  it('admits the verified managed runtime while its catalog identity is still pending', async () => {
    store.setState({
      runtimeEnvironments: [
        {
          id: 'managed',
          name: 'Managed host',
          runtimeId: null,
          createdAt: 1,
          updatedAt: 1,
          pairingRevision: 2,
          lastUsedAt: null,
          endpoints: [],
          preferredEndpointId: 'ws'
        }
      ],
      runtimeStatusByEnvironmentId: new Map([
        [
          'managed',
          {
            checkedAt: 3,
            status: {
              runtimeId: 'verified-server',
              rendererGraphEpoch: 0,
              graphStatus: 'ready',
              authoritativeWindowId: null,
              liveTabCount: 0,
              liveLeafCount: 0,
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 3
            }
          }
        ]
      ])
    })
    mocks.assertCurrent.mockReturnValue({
      executionHostId: 'runtime:managed',
      runtimeEnvironmentId: 'managed'
    })
    mocks.capture.mockReturnValue({ generation: { runtimePairingRevision: 2 } })
    await mount({ ...file, runtimeEnvironmentId: 'managed' })
    expect(mocks.open).toHaveBeenCalledWith(
      expect.objectContaining({
        executionHostId: 'runtime:managed',
        expectedEnvironmentRuntimeId: 'verified-server',
        expectedEnvironmentPairingRevision: 2
      })
    )
    expect(mocks.attach).toHaveBeenCalledOnce()
  })
  it('withholds late viewport and owner-expiry updates after a verified newer file session', async () => {
    await mount()
    await act(async () => {
      store.setState({ openFiles: [{ ...file, fileContentReloadNonce: 1 }] })
      receive({ type: 'ready', viewport: { kind: 'text', startLine: 128, lineCount: 64 } })
      receive({ type: 'error', code: 'unauthorized' })
    })
    expect(store.getState().openFiles[0]?.pluginViewer?.viewport).toBeUndefined()
    expect(store.getState().openFiles[0]?.pluginViewerOwnerExpired).toBeUndefined()
  })
})
