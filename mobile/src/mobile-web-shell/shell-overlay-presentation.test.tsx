import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'

const router = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock('expo-router', () => ({ useRouter: () => router }))
vi.mock('../components/overlay-scrim', () => ({ OverlayScrim: 'OverlayScrim' }))
vi.mock('./ShellDownloadProgress', () => ({ ShellDownloadProgress: 'ShellDownloadProgress' }))

import { useShellOverlay } from './shell-overlay-presentation'

type Overlay = ReturnType<typeof useShellOverlay>

describe('the shell as an overlay', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.clearAllMocks()
  })

  function render(state: MobileWebShellSessionState, enabled = true): Overlay {
    let overlay: Overlay | null = null
    function Probe() {
      overlay = useShellOverlay(enabled, 'desk', state, null)
      return null
    }
    act(() => {
      renderer = create(createElement(Probe))
    })
    return overlay!
  }

  function types(node: ReactNode): string[] {
    let tree: ReactTestRenderer | null = null
    act(() => {
      tree = create(createElement('root', null, node))
    })
    const found = tree!.root.findAll(() => true).map((element) => String(element.type))
    act(() => tree!.unmount())
    return found
  }

  it.each<MobileWebShellSessionState>([
    { kind: 'route-unavailable' },
    { kind: 'failed', reason: 'download-failed', retriedOnce: true },
    { kind: 'offline' }
  ])('opens the host list instead of drawing $kind over the screen beneath', (state) => {
    const overlay = render(state)

    expect(overlay.screen).toBeNull()
    expect(router.replace).toHaveBeenCalledWith('/h/desk')
  })

  it('only dims the screen beneath while the page is on its way, with the bar while downloading', () => {
    expect(types(render({ kind: 'checking' }).screen)).toEqual(['root', 'OverlayScrim'])
    expect(
      types(
        render({
          kind: 'fetching',
          completedAssets: 1,
          totalAssets: 4,
          receivedBytes: 10,
          totalBytes: 40
        }).screen
      )
    ).toEqual(['root', 'OverlayScrim', 'ShellDownloadProgress'])
    expect(router.replace).not.toHaveBeenCalled()
  })

  it('keeps dimming over a ready view until the page paints its own drawer', () => {
    const overlay = render({
      kind: 'ready',
      generationDirectory: 'gen',
      sessionId: 's1',
      buildId: 'b1',
      totalBytes: 1,
      elapsedMs: 1
    })

    expect(overlay.screen).toBeUndefined()
    expect(types(overlay.cover(true))).toEqual(['root', 'OverlayScrim'])
    expect(overlay.cover(false)).toBeNull()
  })

  it('leaves a full-screen shell exactly as it was', () => {
    const overlay = render({ kind: 'route-unavailable' }, false)

    expect(overlay.screen).toBeUndefined()
    expect(overlay.cover(true)).toBeUndefined()
    expect(router.replace).not.toHaveBeenCalled()
  })
})
