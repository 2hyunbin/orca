import { afterEach, expect, it, vi } from 'vitest'
import {
  ACK_WORKTREE,
  createAcknowledgedTabRetirementFixture
} from './acknowledged-terminal-tab-retirement-fixture'
import { delegatedMobileSessionTabClose } from './mobile-session-tab-close-outcome'

const fixtures: ReturnType<typeof createAcknowledgedTabRetirementFixture>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose()
  }
  vi.restoreAllMocks()
})
function fixture() {
  const result = createAcknowledgedTabRetirementFixture()
  fixtures.push(result)
  return result
}

it('keeps persistence writable when worktree teardown finds remaining terminal rows', async () => {
  const f = fixture()
  f.store.updateRepo('repo1', { executionHostId: 'ssh:target' })
  f.store.setWorktreeMeta(ACK_WORKTREE, { hostId: 'ssh:target' })
  f.store.setWorkspaceSession(f.store.getWorkspaceSession(), 'ssh:target')
  vi.spyOn(f.runtime, 'closeMobileSessionTab').mockResolvedValue(delegatedMobileSessionTabClose())
  await expect(f.runtime.closeTerminalsForWorktree(`id:${ACK_WORKTREE}`)).rejects.toThrow(
    'terminal_close_incomplete'
  )
  expect(f.hasTab()).toBe(true)
  await expect(f.store.flushPendingOrThrowAsync()).resolves.toBeUndefined()
})
