import { describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { OrcaRuntimeService } from '../../orca-runtime'
import { notifyLocalPtyProviderRebound } from '../../../ipc/pty/provider/local-provider-rebound'

const FOLDER: FolderWorkspace = {
  id: 'notes-1',
  projectGroupId: 'group-1',
  name: 'Notes',
  folderPath: '/fixture/notes',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1
}
const FOLDER_KEY = folderWorkspaceKey(FOLDER.id)
const LIVE_PTY = (worktreeId: string) => ({
  id: 'pty-agent',
  cwd: FOLDER.folderPath,
  title: 'claude',
  worktreeId,
  incarnationId: 'inc-1'
})

function runtimeWithLiveTerminal(worktreeId: string, live = [LIVE_PTY(worktreeId)]) {
  const applyLayoutCommand = vi.fn(async (_command: { adopt?: { ptyId: string } }) => ({
    ok: true as const,
    result: { tabId: 'tab-new', leafId: 'leaf-new', paneKey: 'tab-new:leaf-new' }
  }))
  const store = {
    getRepos: () => [],
    getProjectGroups: () => [{ id: 'group-1', parentPath: '/fixture' }],
    getFolderWorkspaces: () => [FOLDER],
    getSettings: () => ({}),
    getAllWorktreeMeta: () => ({}),
    getWorkspaceSessionHostIds: () => ['local'],
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    applyLayoutCommand
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the startup pass reads only these store methods.
  const runtime = new OrcaRuntimeService(store as never)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => [...live],
    listProcessesWithHostScope: async () => ({
      processes: [...live],
      hostIds: ['local' as const]
    })
  })
  return { runtime, applyLayoutCommand, live }
}

describe('main’s startup pass over the host census, layout-owner build', () => {
  it('shows a live terminal of a project-group folder workspace in a tab bound to it', async () => {
    const { runtime, applyLayoutCommand } = runtimeWithLiveTerminal(FOLDER_KEY)

    const placement = await runtime.placeUnshownLiveTerminals()

    expect(placement).toEqual({ placed: ['pty-agent'], declined: [] })
    expect(applyLayoutCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'createTerminalTab',
        workspace: FOLDER_KEY,
        adopt: { ptyId: 'pty-agent', incarnationId: 'inc-1' }
      }),
      ['local']
    )
  })

  it('leaves a live terminal of a workspace this host does not know without a tab', async () => {
    const { runtime, applyLayoutCommand } = runtimeWithLiveTerminal('repo-gone::/fixture/gone')

    expect(await runtime.placeUnshownLiveTerminals()).toEqual({ placed: [], declined: [] })
    expect(applyLayoutCommand).not.toHaveBeenCalled()
  })

  it('shows a terminal the replaced terminal service reports, with no client attached', async () => {
    const { runtime, applyLayoutCommand, live } = runtimeWithLiveTerminal(FOLDER_KEY, [])
    await runtime.placeUnshownLiveTerminals()
    expect(applyLayoutCommand).not.toHaveBeenCalled()

    // The terminal service restarted and reports a terminal no pane shows.
    live.push({ ...LIVE_PTY(FOLDER_KEY), id: 'pty-late' })
    notifyLocalPtyProviderRebound()

    await vi.waitFor(() =>
      expect(applyLayoutCommand.mock.calls.map(([command]) => command.adopt?.ptyId)).toEqual([
        'pty-late'
      ])
    )
  })

  it('runs one pass at a time; a call during a pass runs one more pass after it', async () => {
    const { runtime, applyLayoutCommand, live } = runtimeWithLiveTerminal(FOLDER_KEY, [])
    let inFlight = 0
    let overlapped = false
    applyLayoutCommand.mockImplementation(async () => {
      inFlight += 1
      overlapped ||= inFlight > 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return { ok: true as const, result: { tabId: 't', leafId: 'l', paneKey: 't:l' } }
    })
    live.push({ ...LIVE_PTY(FOLDER_KEY), id: 'pty-a' })

    const first = runtime.placeUnshownLiveTerminals()
    live.push({ ...LIVE_PTY(FOLDER_KEY), id: 'pty-b' })
    const second = runtime.placeUnshownLiveTerminals()
    await Promise.all([first, second])

    expect(overlapped).toBe(false)
    expect(applyLayoutCommand.mock.calls.map(([command]) => command.adopt?.ptyId)).toContain(
      'pty-b'
    )
  })
})
