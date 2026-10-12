import { expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'

const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { HEADLESS_LEAF_ID, TEST_WORKTREE_ID, makeWorkspaceSessionWithHeadlessTerminal, store } =
  await import('./orca-runtime-test-fixtures.spec')

// Why: subscribers dedupe on (epoch, version), so a frame emitted at a version without the proofs
// would strand them until an unrelated later bump.
it('emits the stored retirement proofs on the frame a runtime-owned create publishes', async () => {
  store.setWorkspaceSession(makeWorkspaceSessionWithHeadlessTerminal())
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-runtime-fallback' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  runtime.registerPty('persisted-pty', TEST_WORKTREE_ID, null, {
    tabId: 'host-tab',
    leafId: HEADLESS_LEAF_ID
  })
  // A client held a handle for the terminal, so its close leaves a proof.
  const [terminal] = (await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)).terminals
  await runtime.closeTerminal(terminal!.handle)
  const proofs = (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`))
    .retiredTerminalSurfaces
  expect(proofs).toHaveLength(1)
  const events: RuntimeMobileSessionTabsResult[] = []
  const unsubscribe = runtime.onMobileSessionTabsChanged(
    (frame) => events.push(frame),
    'paired-client'
  )

  try {
    await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      activate: false,
      select: false,
      navigation: 'caller',
      clientNavigationId: 'paired-client'
    })

    await vi.waitFor(() => expect(events.at(-1)?.tabs).toHaveLength(1))
    const read = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const emitted = events.at(-1)!
    expect(emitted.snapshotVersion).toBe(read.snapshotVersion)
    expect(emitted.retiredTerminalSurfaces).toEqual(proofs)
  } finally {
    unsubscribe()
  }
})
