import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type PageDependencies = {
  route: { pathname: string; params?: Record<string, string> } | undefined
  clears: { param: string; value: string }[]
  bridged: boolean
}

const page = vi.hoisted((): PageDependencies => ({ route: undefined, clears: [], bridged: true }))

vi.mock('../host-screen/HostScreen', () => ({ HostScreen: () => null }))
vi.mock('../components/WorkspaceDetailPlaceholder', () => ({
  WorkspaceDetailPlaceholder: () => null
}))
vi.mock('./page-owns-host-area', () => ({ usePageOwnsHostArea: () => false }))
vi.mock('../transport/client-context.web', () => ({
  usePageBridgeClientIfPresent: () =>
    page.bridged
      ? {
          getShellSession: () => (page.route ? { route: page.route } : null),
          clearRouteParam: (param: string, value: string) => page.clears.push({ param, value })
        }
      : null
}))

import HostWorktreeRoute from '../../app/h/[hostId]/index.web'

async function render(): Promise<void> {
  await act(async () => {
    create(createElement(HostWorktreeRoute))
  })
}

describe("the worktree list page spending the shell's New Workspace request", () => {
  beforeEach(() => {
    page.route = undefined
    page.clears.length = 0
    page.bridged = true
  })

  it('names the request back so a reload does not reopen the sheet', async () => {
    page.route = { pathname: '/h/host-1', params: { action: 'newWorktree' } }
    await render()
    expect(page.clears).toEqual([{ param: 'action', value: 'newWorktree' }])
  })

  it('posts nothing to a shell that sent no request, so an older shell never sees the frame', async () => {
    page.route = { pathname: '/h/host-1' }
    await render()
    expect(page.clears).toEqual([])
  })

  it('posts nothing outside the shell', async () => {
    page.bridged = false
    await render()
    expect(page.clears).toEqual([])
  })
})
