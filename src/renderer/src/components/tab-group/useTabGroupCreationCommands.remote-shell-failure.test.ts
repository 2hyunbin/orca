import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stubHeadlessReact } from '../tab-bar/tab-bar-windows-shell-launch-render-stubs'

const mocks = vi.hoisted(() => ({
  createTab: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('react', async () => await stubHeadlessReact())
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => 'paired-env'
}))
vi.mock('../../runtime/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: mocks.createWebRuntimeSessionTerminal
}))

const storeState = { createTab: mocks.createTab }
const useAppStore = Object.assign(
  (selector?: (state: typeof storeState) => unknown) =>
    selector ? selector(storeState) : storeState,
  { getState: () => storeState, setState: vi.fn(), subscribe: vi.fn() }
)
vi.mock('../../store', () => ({ useAppStore }))

describe('tab group "+" menu shell launch on a paired host', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('tells the user when the host could not open the picked shell', async () => {
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({
      status: 'failed',
      message: 'The workspace is not connected to a remote Orca host.'
    })
    const { useTabGroupCreationCommands } = await import('./useTabGroupCreationCommands')
    const commands = useTabGroupCreationCommands({
      groupId: 'group-1',
      worktreeId: 'repo::C:/work',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shell command reads no worktree state.
      worktreeState: { mobileEmulatorEnabled: false } as never
    })

    commands.newTerminalWithShell('cmd.exe')

    await vi.waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith("Couldn't open a new terminal.")
    )
    // A paired workspace never falls back to a local shell the user did not ask for.
    expect(mocks.createTab).not.toHaveBeenCalled()
  })
})
