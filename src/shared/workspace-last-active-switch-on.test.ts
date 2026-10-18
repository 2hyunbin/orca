import { describe, expect, it, vi } from 'vitest'
import { getWorkspaceLastActiveAt, withCleanupVisitEvidence } from './workspace-last-active'
import type { WorkspaceCleanupCandidate } from './workspace-cleanup'

vi.mock('./sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 100 * DAY_MS

function candidate(
  overrides: Pick<WorkspaceCleanupCandidate, 'lastActivityAt' | 'reasons'>
): WorkspaceCleanupCandidate {
  return {
    worktreeId: 'repo::/w',
    repoId: 'repo',
    repoName: 'Repo',
    connectionId: null,
    displayName: 'w',
    branch: 'w',
    path: '/w',
    tier: 'ready',
    selectedByDefault: true,
    blockers: [],
    localContext: {
      terminalTabCount: 1,
      cleanEditorTabCount: 0,
      browserTabCount: 0,
      diffCommentCount: 0,
      newestDiffCommentAt: null,
      retainedDoneAgentCount: 0
    },
    git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: NOW },
    fingerprint: 'f',
    ...overrides
  }
}

describe('workspace last active with the switch on', () => {
  it('takes the later of the Recent stamp and the last visit', () => {
    expect(getWorkspaceLastActiveAt(5, 9)).toBe(9)
    expect(getWorkspaceLastActiveAt(9, 5)).toBe(9)
    expect(getWorkspaceLastActiveAt(5, undefined)).toBe(5)
    expect(getWorkspaceLastActiveAt(5, Number.NaN)).toBe(5)
  })

  it('a newer visit only drops the idle reasons it disproves', () => {
    const archived = candidate({
      lastActivityAt: NOW - 40 * DAY_MS,
      reasons: ['archived', 'idle-clean']
    })
    // Ten days ago: still archived-idle (7 d), no longer idle-clean (30 d).
    expect(withCleanupVisitEvidence(archived, NOW - 10 * DAY_MS, NOW)).toMatchObject({
      lastActivityAt: NOW - 10 * DAY_MS,
      reasons: ['archived']
    })
    // An older visit changes nothing.
    expect(withCleanupVisitEvidence(archived, NOW - 50 * DAY_MS, NOW)).toBe(archived)
  })
})
