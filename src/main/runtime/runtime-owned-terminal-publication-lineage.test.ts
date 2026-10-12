import { expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { store, TEST_WORKTREE_ID } = await import('./orca-runtime-test-fixtures.spec')

// A phone drops updates whose epoch differs from the one its create returned.
it('keeps the paired client on the live epoch after runtime-owned terminal creation', async () => {
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'pty-runtime-fallback' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const events: RuntimeMobileSessionTabsResult[] = []
  const unsubscribe = runtime.onMobileSessionTabsChanged(
    (snapshot) => events.push(snapshot),
    'paired-client'
  )
  try {
    const created = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      activate: false,
      select: false,
      navigation: 'caller',
      clientNavigationId: 'paired-client'
    })
    expect(created.tab.status).toBe('ready')
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({
        publicationEpoch: `${created.publicationEpoch}:client-navigation`,
        snapshotVersion: expect.any(Number),
        tabs: [expect.objectContaining({ id: created.tab.id, status: 'ready' })]
      })
    )
    expect(events.at(-1)!.snapshotVersion).toBeGreaterThanOrEqual(created.snapshotVersion)
  } finally {
    unsubscribe()
  }
})
