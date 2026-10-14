import { describe, expect, it } from 'vitest'
import {
  GitCancelGeneration,
  GitGenerateCommitMessage,
  GitGeneratePullRequestFields,
  WorktreeSelector
} from './git-params'

const fields = { base: 'main', title: '', body: '', draft: false }

describe('optional source control generation identity', () => {
  it.each([GitGenerateCommitMessage, GitGeneratePullRequestFields, GitCancelGeneration])(
    'accepts old clients without an identity',
    (schema) => {
      expect(schema.parse({ worktree: 'id:wt-1', ...fields })).not.toHaveProperty('generationId')
    }
  )

  it.each([GitGenerateCommitMessage, GitGeneratePullRequestFields, GitCancelGeneration])(
    'preserves a bounded opaque identity on new hosts',
    (schema) => {
      expect(
        schema.parse({ worktree: 'id:wt-1', ...fields, generationId: 'opaque-request-1' })
      ).toHaveProperty('generationId', 'opaque-request-1')
      expect(schema.safeParse({ worktree: 'id:wt-1', ...fields, generationId: '' }).success).toBe(
        false
      )
      expect(
        schema.safeParse({ worktree: 'id:wt-1', ...fields, generationId: 'x'.repeat(129) }).success
      ).toBe(false)
    }
  )

  it('old host schemas strip the new field and retain legacy path cancellation', () => {
    const request = { worktree: 'id:wt-1', generationId: 'opaque-request-1' }
    const legacyGenerate = GitGenerateCommitMessage.omit({ generationId: true })
    const legacyFields = GitGeneratePullRequestFields.omit({ generationId: true })
    expect(legacyGenerate.parse(request)).toEqual({ worktree: 'id:wt-1' })
    expect(legacyFields.parse({ ...request, ...fields })).toEqual({
      worktree: 'id:wt-1',
      ...fields
    })
    expect(WorktreeSelector.parse(request)).toEqual({ worktree: 'id:wt-1' })
  })
})
