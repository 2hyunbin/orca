import { expect, it, vi } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-types'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const binding = {
  worktreeId: 'repo-local::/fixture/local',
  tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ptyId: 'retiring-pty',
  incarnationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
}
class RetirementRuntime extends OrcaRuntimeService {
  readVisibleState() {
    return this.readVisibleTerminalState(binding.ptyId)
  }
  snapshot(): RuntimeMobileSessionTabsSnapshot | undefined {
    return this.readSessionTabsSnapshot(binding.worktreeId)
  }
  /** The fixture's own tab shares the worktree, so phone rows are scoped to the binding's tab. */
  bindingRows() {
    return (this.snapshot()?.tabs ?? []).filter(
      (tab) => tab.type === 'terminal' && tab.parentTabId === binding.tabId
    )
  }
  generations(): number {
    return this.ptyLifecycleGenerationById.size
  }
  async closeTab(): Promise<void> {
    const snapshot = this.snapshot()
    const tab = this.bindingRows()[0]
    if (!snapshot || tab?.type !== 'terminal') {
      throw new Error('missing test tab')
    }
    await this.closeHeadlessMobileTerminalTab(binding.worktreeId, snapshot, tab)
  }
}

it.each(['read', 'replacement', 'legacy-replacement'] as const)(
  'publishes an exited terminal retirement with concurrent %s',
  async (action) => {
    const { store, authority, readState } = await fixture()
    await store.persistPtyBinding(binding)
    const runtime = new RetirementRuntime(store)
    runtime.registerPty(binding.ptyId, binding.worktreeId, null, binding)
    expect(runtime.bindingRows()).toHaveLength(1)
    const gate = authority.pause()
    const exiting = runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, {
      providerExitObserved: true
    })
    await gate.started.promise
    if (action === 'read') {
      await runtime.readVisibleState()
    } else if (action === 'legacy-replacement') {
      runtime.onPtySpawned(binding.ptyId)
    } else {
      runtime.onPtySpawned(binding.ptyId, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')
    }
    gate.finish.resolve()
    await exiting
    expect(readState().workspaceSession.terminalLayoutsByTabId[binding.tabId]).toBeUndefined()
    // Why every action: the exit retired the leaf in memory before any of them could run.
    expect(runtime.bindingRows()).toHaveLength(0)
  }
)

it('publishes an exit of a terminal bound only in its saved layout', async () => {
  const { store, authority, readState } = await fixture()
  await store.persistPtyBinding(binding)
  const runtime = new RetirementRuntime(store)
  expect(runtime.bindingRows()).toHaveLength(1)
  const gate = authority.pause()
  const exiting = runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, {
    providerExitObserved: true
  })
  await gate.started.promise
  gate.finish.resolve()
  await exiting
  expect(readState().workspaceSession.terminalLayoutsByTabId[binding.tabId]).toBeUndefined()
  expect(runtime.bindingRows()).toEqual([])
  expect(runtime.generations()).toBe(0)
})

it('completes a durable close and refuses a split queued behind it', async () => {
  const { store, authority, readState } = await fixture()
  await store.persistPtyBinding(binding)
  const runtime = new RetirementRuntime(store)
  const kill = vi.fn(() => true)
  runtime.setPtyController({ write: () => true, kill, getForegroundProcess: async () => null })
  runtime.registerPty(binding.ptyId, binding.worktreeId, null, binding)
  const gate = authority.pause()
  const close = runtime.closeTab()
  await gate.started.promise
  const split = store.persistPtyBinding({
    ...binding,
    leafId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    ptyId: 'concurrent-split',
    expectedSourceBinding: binding
  })
  gate.finish.resolve()
  await close
  await expect(split).resolves.toBe(false)
  expect(kill).toHaveBeenCalledExactlyOnceWith(binding.ptyId)
  expect(runtime.bindingRows()).toEqual([])
  expect(readState().workspaceSession.terminalLayoutsByTabId[binding.tabId]).toBeUndefined()
})
