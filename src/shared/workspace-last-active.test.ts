import { describe, expect, it } from 'vitest'
import { getWorkspaceLastActiveAt } from './workspace-last-active'

// Switch off (the default build): visits never change what readers call "last active".
describe('getWorkspaceLastActiveAt with the switch off', () => {
  it('reads the Recent stamp alone', () => {
    expect(getWorkspaceLastActiveAt(5, 9)).toBe(5)
  })
})

describe('withCleanupVisitEvidence with the switch off', () => {
  it('returns the candidate as main built it', async () => {
    const { withCleanupVisitEvidence } = await import('./workspace-last-active')
    const candidate = {
      worktreeId: 'repo::/w',
      repoId: 'repo',
      repoName: 'Repo',
      connectionId: null,
      displayName: 'w',
      branch: 'w',
      path: '/w',
      tier: 'ready' as const,
      selectedByDefault: true,
      reasons: ['idle-clean' as const],
      blockers: [],
      lastActivityAt: 5,
      localContext: {
        terminalTabCount: 1,
        cleanEditorTabCount: 0,
        browserTabCount: 0,
        diffCommentCount: 0,
        newestDiffCommentAt: null,
        retainedDoneAgentCount: 0
      },
      git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 1 },
      fingerprint: 'f'
    }
    expect(withCleanupVisitEvidence(candidate, 9, 10)).toBe(candidate)
  })
})
