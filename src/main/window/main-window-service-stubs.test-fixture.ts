import { vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

type MockFn = ReturnType<typeof vi.fn>

export type MainWindowStub = {
  id?: number
  isDestroyed?: MockFn
  on: MockFn
  once: MockFn
  webContents: {
    id?: number
    getURL: MockFn
    isDestroyed?: MockFn
    isLoadingMainFrame: MockFn
    on: MockFn
    send?: MockFn
    reload?: MockFn
    session: {
      setPermissionRequestHandler: MockFn
      setPermissionCheckHandler: MockFn
    }
  }
}

export function createMainWindowServiceStub(
  permissionHandlers: {
    setPermissionRequestHandler: MockFn
    setPermissionCheckHandler: MockFn
  },
  extraWebContents: { isLoadingMainFrame?: MockFn; on?: MockFn; send?: MockFn } = {}
): MainWindowStub {
  return {
    id: 1,
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    once: vi.fn(),
    webContents: {
      id: 1,
      getURL: vi.fn(() => 'file:///opt/orca/renderer/index.html'),
      isDestroyed: vi.fn(() => false),
      isLoadingMainFrame: vi.fn(() => true),
      on: vi.fn(),
      reload: vi.fn(),
      session: {
        setPermissionRequestHandler: permissionHandlers.setPermissionRequestHandler,
        setPermissionCheckHandler: permissionHandlers.setPermissionCheckHandler
      },
      ...extraWebContents
    }
  }
}

export function createRuntime() {
  return {
    attachWindow: vi.fn<OrcaRuntimeService['attachWindow']>(),
    setNotifier: vi.fn<OrcaRuntimeService['setNotifier']>(),
    markRendererReloading: vi.fn<OrcaRuntimeService['markRendererReloading']>(() => null),
    markRendererReloadCancelled: vi.fn<OrcaRuntimeService['markRendererReloadCancelled']>(
      () => false
    ),
    markGraphReloadFailed: vi.fn<OrcaRuntimeService['markGraphReloadFailed']>(),
    markGraphUnavailable: vi.fn<OrcaRuntimeService['markGraphUnavailable']>()
  }
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}
