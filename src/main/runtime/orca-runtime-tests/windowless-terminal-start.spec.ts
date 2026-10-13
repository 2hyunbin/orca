import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID,
  makeDeferred,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-test-fixtures.spec'

const WT = `id:${TEST_WORKTREE_ID}`

describe('a terminal a host with no window starts', () => {
  // Why: a client that types into a listed tab before its process is bound loses the keys.
  it('is listed once its start ends, not while its process starts', async () => {
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
      makeWorkspaceSessionWithHeadlessTerminal()
    )
    const runtime = new OrcaRuntimeService(runtimeStore)
    const started = makeDeferred()
    const spawn = vi.fn(async () => {
      await started.promise
      return { id: 'created-pty' }
    })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => []
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const listedTabs = async () =>
      new Set(
        (await runtime.listMobileSessionTabs(WT)).tabs.flatMap((tab) =>
          tab.type === 'terminal' ? [tab.parentTabId] : []
        )
      )
    expect(await listedTabs()).toEqual(new Set(['host-tab']))

    const creating = runtime.createMobileSessionTerminal(WT)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    expect(await listedTabs()).toEqual(new Set(['host-tab']))

    started.resolve()
    const created = await creating
    expect(await listedTabs()).toEqual(new Set(['host-tab', created.tab.parentTabId]))
  })
})
