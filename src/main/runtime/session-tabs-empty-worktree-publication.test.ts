import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE = 'repo::/never-opened'

type WorktreeAnswerInternals = {
  getMobileSessionTabsForWorktree: (
    worktreeId: string,
    clientNavigationId?: string
  ) => RuntimeMobileSessionTabsResult
}

function createHeadedRuntime(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these tests only reach listProcesses.
  runtime.setPtyController({ listProcesses: vi.fn(async () => []) } as never)
  runtime.attachWindow(1)
  return runtime
}

function answerFor(runtime: OrcaRuntimeService, clientNavigationId?: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads the runtime's own per-worktree answer.
  return (runtime as unknown as WorktreeAnswerInternals).getMobileSessionTabsForWorktree(
    WORKTREE,
    clientNavigationId
  )
}

describe('answering for a worktree the host has no tabs for', () => {
  // The holder loads from the Store before any window publishes, so there is no "ask me later".
  it('answers with a real empty list before any renderer graph', () => {
    const runtime = createHeadedRuntime()
    for (const answer of [answerFor(runtime), answerFor(runtime, 'device-1')]) {
      expect(answer.publicationEpoch).toMatch(/^layout:/)
      expect(answer.tabs).toEqual([])
    }
  })
})
