import { createElement, useEffect, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShellOverlayLoad } from '../mobile-web-shell/shell-overlay-load'
import type { OverlayDownload } from '../components/overlay-scrim'

type OverlayLoadingLayerProps = { download: OverlayDownload | null; onDismiss: () => void }

const router = vi.hoisted(() => ({ back: vi.fn() }))
const shell = vi.hoisted((): { report: ((load: ShellOverlayLoad) => void) | null } => ({
  report: null
}))
const layerMounts = vi.hoisted(() => ({ count: 0 }))

vi.mock('expo-router', () => ({ useRouter: () => router }))
vi.mock('../components/HostProtocolGate', () => ({
  HostProtocolGate: ({ children }: { children: ReactNode }) => children
}))
vi.mock('../mobile-web-shell/MobileWebShellScreen', () => ({
  MobileWebShellScreen: ({
    onOverlayLoad
  }: {
    onOverlayLoad: (load: ShellOverlayLoad) => void
  }) => {
    shell.report = onOverlayLoad
    return null
  }
}))
vi.mock('../components/overlay-scrim', async () => {
  const { createElement: element } = await import('react')
  return {
    OverlayLoadingLayer: (props: OverlayLoadingLayerProps) => {
      useEffect(() => {
        layerMounts.count += 1
      }, [])
      return element('OverlayLoadingLayer', props)
    }
  }
})

import { NewWorkspaceOverlay } from './NewWorkspaceOverlay'

describe("the New Workspace overlay's loading layer", () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    shell.report = null
    layerMounts.count = 0
    vi.clearAllMocks()
  })

  function layer() {
    return renderer!.root.findAll((node) => String(node.type) === 'OverlayLoadingLayer')[0]
  }

  it('stays one mounted layer from the first wait through the download until the page paints', () => {
    act(() => {
      renderer = create(createElement(NewWorkspaceOverlay, { hostId: 'desk' }))
    })
    expect(layer().props.download).toBeNull()

    act(() => shell.report!({ kind: 'loading', download: { receivedBytes: 1, totalBytes: 8 } }))
    expect(layer().props.download).toEqual({ receivedBytes: 1, totalBytes: 8 })
    act(() => shell.report!({ kind: 'loading', download: null }))
    expect(layer().props.download).toBeNull()
    expect(layerMounts.count).toBe(1)

    act(() => shell.report!({ kind: 'painted' }))
    expect(layer()).toBeUndefined()
  })

  it('leaves when the scrim is tapped mid-load', () => {
    act(() => {
      renderer = create(createElement(NewWorkspaceOverlay, { hostId: 'desk' }))
    })

    act(() => layer().props.onDismiss())

    expect(router.back).toHaveBeenCalledTimes(1)
  })
})
