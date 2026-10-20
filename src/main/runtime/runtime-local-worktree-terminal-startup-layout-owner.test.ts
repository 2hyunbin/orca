import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import { startRuntimeLocalWorktreeTerminals } from './runtime-local-worktree-terminal-startup'

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1
}

const worktree: Worktree = {
  id: 'worktree-1',
  repoId: repo.id,
  path: '/worktree',
  head: 'abc',
  branch: 'feature',
  isBare: false,
  isMainWorktree: false,
  displayName: 'feature',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
}

type StartupArgs = Parameters<typeof startRuntimeLocalWorktreeTerminals>[0]

function createPorts() {
  const createTerminal = vi.fn<StartupArgs['ports']['createTerminal']>().mockResolvedValue({
    handle: 'term-1',
    worktreeId: worktree.id,
    title: null
  })
  const ports: StartupArgs['ports'] = {
    canSpawn: true,
    createTerminal,
    pasteDraft: vi.fn(),
    sendFollowup: vi.fn(),
    provision: vi.fn().mockResolvedValue({ setupSpawned: false, setupTerminalHandle: null }),
    activate: vi.fn()
  }
  return { createTerminal, ports }
}

describe('layout-owner build: a create whose agent failed to start', () => {
  it('still provisions setup and default tabs in main, and hands the window nothing to retry', async () => {
    const { ports, createTerminal } = createPorts()
    createTerminal.mockRejectedValueOnce(new Error('pty unavailable'))
    const setup = { runnerScriptPath: '/repo/setup.sh', envVars: {} }
    const defaultTabs = { runCommands: true, tabs: [{ title: 'Dev', command: 'pnpm dev' }] }
    await startRuntimeLocalWorktreeTerminals({
      request: {
        repoSelector: repo.id,
        name: 'recover',
        activate: true,
        awaitTerminalProvisioning: true
      },
      repo,
      worktree,
      startup: { command: 'codex' },
      setup,
      defaultTabs,
      ports
    })
    expect(ports.provision).toHaveBeenCalledWith(
      expect.objectContaining({ setup, defaultTabs, hasStartupTerminal: false })
    )
    // Setup did not start here either (the fake spawns nothing), and still stays main's.
    expect(ports.activate).toHaveBeenCalledWith(
      repo.id,
      worktree.id,
      undefined,
      undefined,
      undefined
    )
  })
})
