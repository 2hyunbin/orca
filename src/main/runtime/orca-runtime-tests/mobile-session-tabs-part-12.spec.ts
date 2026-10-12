import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  store,
  withPlatform
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('rejects startup prompts for agents that require post-ready stdin', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent-prompt' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: {}
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'aider',
        agentPrompt: 'Review this diff'
      })
    ).rejects.toThrow('does not support startup prompt quick commands')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('uses portable Unix quoting for mobile agent launch commands in WSL project runtimes', async () => {
    await withPlatform('win32', async () => {
      const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent' })
      const runtime = new OrcaRuntimeService({
        ...store,
        getProjects: () => [
          {
            id: 'project-1',
            displayName: 'repo',
            badgeColor: 'blue',
            sourceRepoIds: [TEST_REPO_ID],
            localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
            createdAt: 0,
            updatedAt: 0
          }
        ],
        getSettings: () => ({
          ...store.getSettings(),
          disabledTuiAgents: [],
          agentCmdOverrides: { 'command-code': 'command-code --profile mobile' },
          agentDefaultArgs: { 'command-code': '--note "can\'t"' },
          localWindowsRuntimeDefault: { kind: 'windows-host' }
        })
      } as never)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

      await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'command-code'
      })

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          command: `command-code --profile mobile '--note' 'can'"'"'t'`,
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID
        })
      )
    })
  })

  it('keeps PowerShell quoting for mobile agent launch commands in Windows host runtimes', async () => {
    await withPlatform('win32', async () => {
      const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent' })
      const runtime = new OrcaRuntimeService({
        ...store,
        getProjects: () => [
          {
            id: 'project-1',
            displayName: 'repo',
            badgeColor: 'blue',
            sourceRepoIds: [TEST_REPO_ID],
            localWindowsRuntimePreference: { kind: 'windows-host' },
            createdAt: 0,
            updatedAt: 0
          }
        ],
        getSettings: () => ({
          ...store.getSettings(),
          disabledTuiAgents: [],
          agentCmdOverrides: { 'command-code': 'command-code --profile mobile' },
          agentDefaultArgs: { 'command-code': '--note "can\'t"' },
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
        })
      } as never)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

      await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'command-code'
      })

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "command-code --profile mobile '--note' 'can''t'",
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID
        })
      )
    })
  })

  it('uses cmd.exe quoting for mobile agent launch commands in local Windows host runtimes', async () => {
    await withPlatform('win32', async () => {
      const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent-cmd' })
      const runtime = new OrcaRuntimeService({
        ...store,
        getProjects: () => [
          {
            id: 'project-1',
            displayName: 'repo',
            badgeColor: 'blue',
            sourceRepoIds: [TEST_REPO_ID],
            localWindowsRuntimePreference: { kind: 'windows-host' },
            createdAt: 0,
            updatedAt: 0
          }
        ],
        getSettings: () => ({
          ...store.getSettings(),
          disabledTuiAgents: [],
          agentCmdOverrides: { 'command-code': 'command-code --profile mobile' },
          agentDefaultArgs: { 'command-code': '--note "can\'t"' },
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' },
          terminalWindowsShell: 'cmd.exe'
        })
      } as never)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

      await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'command-code'
      })

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'command-code --profile mobile "--note" "can\'t"',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID
        })
      )
    })
  })

  it('publishes headless mobile session agent identity with synthesized PTY status', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: {}
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const created = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      agent: 'claude'
    })
    runtime.onPtyData('pty-agent', '\x1b]0;✳ Claude Code\x07', Date.now())

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)

    expect(created.tab).toMatchObject({
      type: 'terminal',
      launchAgent: 'claude'
    })
    expect(listed.tabs).toEqual([
      expect.objectContaining({
        type: 'terminal',
        launchAgent: 'claude',
        agentStatus: expect.objectContaining({
          state: 'done',
          agentType: 'claude'
        })
      })
    ])
  })

  it('rejects disabled mobile session agent launches before spawning', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: ['codex'],
        agentCmdOverrides: {}
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        agent: 'codex'
      })
    ).rejects.toThrow('Selected agent is disabled')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('validates mobile terminal insertion anchors before resolving agent launch commands', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: ['codex'],
        agentCmdOverrides: {}
      })
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        afterTabId: 'stale-tab',
        agent: 'codex'
      })
    ).rejects.toThrow('after_tab_not_found')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('dedupes concurrent mobile terminal creates that share a clientMutationId', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-created' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const [first, second] = await Promise.all([
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: false,
        clientMutationId: 'mutation-1'
      }),
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        activate: false,
        clientMutationId: 'mutation-1'
      })
    ])

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
  })

  it('returns the settled success for a retried clientMutationId whose response was lost', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-created' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })

    const first = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      activate: false,
      clientMutationId: 'mutation-lost-response'
    })
    // Why: the phone retries the same key when the create response was lost; within the retention window it must reuse the terminal.
    const retried = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      activate: false,
      clientMutationId: 'mutation-lost-response'
    })

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(retried).toBe(first)
  })
})
