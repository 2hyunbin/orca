// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspacePort, WorkspacePortScanResult } from '../../../../shared/workspace-ports'

const {
  activateAndRevealWorktreeMock,
  createBrowserTabMock,
  openUrlMock,
  recordFeatureInteractionMock,
  setRemoteBrowserPageHandleMock,
  callRuntimeRpcMock,
  storeState,
  resetStore
} = vi.hoisted(() => {
  const workspacePortScansByKey: Record<string, WorkspacePortScanResult> = {}
  const initialProjection: {
    workspacePortScan: { key: string; result: WorkspacePortScanResult } | null
  } = { workspacePortScan: null }
  const state = {
    settings: { openLinksInApp: true },
    createBrowserTab: vi.fn(),
    setRemoteBrowserPageHandle: vi.fn(),
    replaceWorkspacePortScans: vi.fn(),
    setWorkspacePortScanRefreshing: vi.fn(),
    recordFeatureInteraction: vi.fn(),
    workspacePortScansByKey,
    ...initialProjection
  }
  return {
    activateAndRevealWorktreeMock: vi.fn(),
    createBrowserTabMock: state.createBrowserTab,
    openUrlMock: vi.fn(),
    recordFeatureInteractionMock: state.recordFeatureInteraction,
    setRemoteBrowserPageHandleMock: state.setRemoteBrowserPageHandle,
    callRuntimeRpcMock: vi.fn(),
    storeState: state,
    resetStore: { current: () => {} }
  }
})

vi.mock('@/store', async () => {
  const { useStore } = await import('zustand')
  const { createStore } = await import('zustand/vanilla')
  const store = createStore(() => storeState)
  resetStore.current = () => store.setState({ ...storeState }, true)
  storeState.replaceWorkspacePortScans.mockImplementation((scansByKey, projection) =>
    store.setState({ workspacePortScansByKey: scansByKey, workspacePortScan: projection })
  )
  const useAppStore = Object.assign(
    (selector: (state: typeof storeState) => unknown) => useStore(store, selector),
    { getState: store.getState }
  )
  return { useAppStore }
})

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: activateAndRevealWorktreeMock
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: (_state: unknown, id: string | null) =>
    id === 'repo-b::/repo-b' ? 'runtime:host-b' : 'local'
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: callRuntimeRpcMock,
  assertRuntimeEnvironmentCapability: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@/runtime/runtime-rpc-result', () => ({
  RuntimeRpcCallError: class RuntimeRpcCallError extends Error {
    code?: string
  }
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn()
  }
}))

import { PortRow } from './ports-status-popover-rows'
import {
  mergeWorkspacePortScans,
  publishWorkspacePortScanForHost
} from '@/lib/workspace-port-actions'
import { useAppStore } from '@/store'
import { workspacePortHostForRow } from '@/lib/workspace-port-host-availability'
import { toast } from 'sonner'

const externalPort: WorkspacePort = {
  id: '127.0.0.1:63468:1234',
  bindHost: '127.0.0.1',
  connectHost: '127.0.0.1',
  port: 63468,
  pid: 1234,
  processName: 'node',
  protocol: 'http',
  kind: 'external'
}

describe('status bar port row open routing', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (X11; Linux x86_64)',
      configurable: true
    })
    ;(window as unknown as { api: unknown }).api = {
      shell: {
        openUrl: openUrlMock
      },
      ui: {
        writeClipboardText: vi.fn()
      }
    }
    openUrlMock.mockResolvedValue(undefined)
    createBrowserTabMock.mockReset()
    openUrlMock.mockClear()
    recordFeatureInteractionMock.mockClear()
    setRemoteBrowserPageHandleMock.mockClear()
    activateAndRevealWorktreeMock.mockClear()
    callRuntimeRpcMock.mockReset()
    callRuntimeRpcMock.mockResolvedValue({ browserPageId: 'remote-page' })
    vi.mocked(toast.error).mockClear()
    storeState.workspacePortScansByKey = {
      'local:all': { platform: 'darwin', scannedAt: 0, ports: [externalPort] }
    }
    resetStore.current()
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  function renderPortRow(
    port: WorkspacePort = externalPort,
    activeWorktreeId: string | null = null
  ): HTMLButtonElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    resetStore.current()
    act(() => {
      root.render(<PortRow port={port} activeWorktreeId={activeWorktreeId} external />)
    })
    const openButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open in Browser"]'
    )
    if (!openButton) {
      throw new Error('expected Open in Browser button')
    }
    expect(container.textContent).toContain('Open in Browser. Shift+Ctrl+click for system browser')
    return openButton
  }

  it('keeps the open button enabled and forwards Shift+Ctrl-click to system-browser routing', async () => {
    const openButton = renderPortRow()

    expect(openButton.disabled).toBe(false)

    await act(async () => {
      openButton.dispatchEvent(
        new window.MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          detail: 1,
          shiftKey: true
        })
      )
      await Promise.resolve()
    })

    expect(recordFeatureInteractionMock).toHaveBeenCalledWith('ports')
    expect(openUrlMock).toHaveBeenCalledWith('http://127.0.0.1:63468')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(activateAndRevealWorktreeMock).not.toHaveBeenCalled()
  })

  it('keeps no-pointer activations on the saved link-routing setting', async () => {
    const openButton = renderPortRow()

    expect(openButton.disabled).toBe(false)

    await act(async () => {
      openButton.dispatchEvent(
        new window.MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          shiftKey: true
        })
      )
      await Promise.resolve()
    })

    expect(recordFeatureInteractionMock).toHaveBeenCalledWith('ports')
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('opens an ownerless host-B row on B while host A is active, without granting Stop or falling back on failure', async () => {
    const owned: WorkspacePort = {
      ...externalPort,
      kind: 'workspace',
      owner: {
        worktreeId: 'repo-b::/repo-b',
        repoId: 'repo-b',
        displayName: 'B',
        path: '/repo-b',
        confidence: 'cwd'
      }
    }
    const scans = (port: WorkspacePort): Record<string, WorkspacePortScanResult> => ({
      'local:all': { platform: 'darwin', scannedAt: 0, ports: [externalPort] },
      'environment:host-b:all': { platform: 'darwin', scannedAt: 1, ports: [port] }
    })
    storeState.workspacePortScansByKey = scans(owned)
    const ownedRow = mergeWorkspacePortScans(storeState.workspacePortScansByKey)?.ports.find(
      (port) => port.kind === 'workspace'
    )
    if (!ownedRow) {
      throw new Error('expected host-B workspace row')
    }
    const openButton = renderPortRow(ownedRow, 'repo-a::/repo-a')
    await act(async () => openButton.click())
    expect(callRuntimeRpcMock).toHaveBeenLastCalledWith(
      { kind: 'environment', environmentId: 'host-b' },
      'browser.tabCreate',
      { worktree: 'id:repo-b::/repo-b', url: 'http://127.0.0.1:63468' },
      { timeoutMs: 30_000 }
    )

    const ownerless: WorkspacePort = { ...externalPort, pid: undefined, processName: undefined }
    storeState.workspacePortScansByKey = scans(ownerless)
    const row = mergeWorkspacePortScans(storeState.workspacePortScansByKey)?.ports.find((port) =>
      port.id.startsWith('environment:host-b:all:')
    )
    if (!row) {
      throw new Error('expected ownerless host-B row')
    }
    act(() => resetStore.current())
    act(() => root.render(<PortRow port={row} activeWorktreeId="repo-a::/repo-a" external />))
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Stop Process"]')?.disabled
    ).toBe(true)
    await act(async () => openButton.click())
    expect(callRuntimeRpcMock).toHaveBeenLastCalledWith(
      { kind: 'environment', environmentId: 'host-b' },
      'browser.tabCreate',
      { url: 'http://127.0.0.1:63468' },
      { timeoutMs: 30_000 }
    )
    expect(row).not.toHaveProperty('owner')
    expect(setRemoteBrowserPageHandleMock).toHaveBeenLastCalledWith(expect.any(String), {
      environmentId: 'host-b',
      remotePageId: 'remote-page'
    })
    const createdTabs = createBrowserTabMock.mock.calls.length
    callRuntimeRpcMock.mockRejectedValueOnce(new Error('host B disconnected'))
    await act(async () => openButton.click())
    expect(toast.error).toHaveBeenCalledWith('Failed to open browser', {
      description: 'host B disconnected'
    })
    expect(createBrowserTabMock).toHaveBeenCalledTimes(createdTabs)
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it.each([100, 1_000])(
    'shares linear source work across %i subscribed rows and changed publications',
    async (population) => {
      let reads = 0
      const scans = Object.fromEntries(
        Array.from({ length: population / 50 }, (_, host) => [
          `environment:host:${host}:all`,
          {
            platform: 'darwin' as const,
            scannedAt: 0,
            ports: Array.from({ length: 50 }, (_, row) => ({
              ...externalPort,
              pid: undefined,
              port: 20_000 + host * 50 + row,
              get id() {
                reads += 1
                return `tcp:${host * 50 + row}`
              }
            }))
          }
        ])
      )
      storeState.workspacePortScansByKey = scans
      resetStore.current()
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
      function Rows(): React.JSX.Element {
        const projection = useAppStore((state) => state.workspacePortScan)
        return (
          <>
            {projection?.result.ports.map((port) => (
              <PortRow key={port.id} port={port} activeWorktreeId="repo-a::/repo-a" external />
            ))}
          </>
        )
      }
      act(() => root.render(<Rows />))
      let previousRow: WorkspacePort | undefined
      for (const generation of [1, 2]) {
        reads = 0
        act(() =>
          publishWorkspacePortScanForHost({
            getWorkspacePortScansByKey: () => useAppStore.getState().workspacePortScansByKey,
            replaceWorkspacePortScans: storeState.replaceWorkspacePortScans,
            scanKey: 'environment:host:1:all',
            scan: {
              ...scans['environment:host:1:all'],
              scannedAt: generation,
              ports: scans['environment:host:1:all'].ports.map((port) => ({
                ...port,
                id: `generation:${generation}:${port.id}`
              }))
            }
          })
        )
        // Aggregate spread/id reads and one shared index each get a linear allowance.
        expect(reads).toBeGreaterThanOrEqual(population)
        expect(reads).toBeLessThanOrEqual(4 * population)
        const current = useAppStore.getState()
        const row = current.workspacePortScan?.result.ports.find((port) => port.port === 20_050)
        if (!row) {
          throw new Error('expected host B row')
        }
        if (previousRow) {
          expect(workspacePortHostForRow(previousRow, current.workspacePortScansByKey)).toEqual({
            kind: 'unknown'
          })
        }
        previousRow = row
        const before = reads
        for (const port of current.workspacePortScan?.result.ports ?? []) {
          workspacePortHostForRow(port, current.workspacePortScansByKey)
        }
        expect(reads).toBe(before)
        expect(container.querySelectorAll('button[aria-label="Open in Browser"]')).toHaveLength(
          population
        )
        expect(
          [
            ...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Stop Process"]')
          ].every((button) => button.disabled)
        ).toBe(true)
        const button = container.querySelectorAll<HTMLButtonElement>(
          'button[aria-label="Open in Browser"]'
        )[current.workspacePortScan?.result.ports.indexOf(row) ?? -1]
        await act(async () => button.click())
        expect(callRuntimeRpcMock).toHaveBeenLastCalledWith(
          { kind: 'environment', environmentId: 'host:1' },
          'browser.tabCreate',
          { url: 'http://127.0.0.1:20050' },
          { timeoutMs: 30_000 }
        )
        expect(setRemoteBrowserPageHandleMock).toHaveBeenLastCalledWith(expect.any(String), {
          environmentId: 'host:1',
          remotePageId: 'remote-page'
        })
      }
    }
  )
})
