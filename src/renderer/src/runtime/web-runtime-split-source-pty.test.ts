import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readHostPublishedSplitSourcePtyId } from './web-runtime-split-source-pty'

const TAB = 'web-terminal-host-tab-1'
const SOURCE = { worktreeId: 'worktree-1', tabId: TAB, leafId: 'leaf-1' }

const mocks = vi.hoisted(() => {
  const owner: { environmentId: string | null } = { environmentId: 'env-1' }
  return { owner }
})

vi.mock('../store', () => ({
  useAppStore: {
    getState: () => ({
      terminalLayoutsByTabId: {
        'web-terminal-host-tab-1': { ptyIdsByLeafId: { 'leaf-1': 'remote:env-1@@terminal-1' } }
      }
    })
  }
}))
vi.mock('../lib/resolve-owner', () => ({
  runtimeEnvironmentIdUnlessTwin: () => mocks.owner.environmentId
}))

describe('readHostPublishedSplitSourcePtyId', () => {
  beforeEach(() => {
    mocks.owner.environmentId = 'env-1'
  })

  it('reads the terminal the workspace’s server published for the pane', () => {
    expect(readHostPublishedSplitSourcePtyId(SOURCE)).toBe('remote:env-1@@terminal-1')
  })

  // A split sent from it would run on a server the workspace no longer belongs to.
  it('ignores a binding naming another server', () => {
    mocks.owner.environmentId = 'env-2'
    expect(readHostPublishedSplitSourcePtyId(SOURCE)).toBeNull()
  })
})
