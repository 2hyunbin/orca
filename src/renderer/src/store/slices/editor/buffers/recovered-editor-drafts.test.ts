import { expect, it, vi } from 'vitest'
import type { RecoveredEditorDraft } from '../../../../../../shared/workspace-session-state-types'
import { appendRecoveredEditorDrafts } from './recovered-editor-drafts'

function draft(recoveredAt: number, text = 'draft'): RecoveredEditorDraft {
  return { filePath: `/repo/${recoveredAt}.ts`, worktreeId: 'wt', draft: text, recoveredAt }
}

it('keeps the 20 newest recovered drafts', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const existing = Array.from({ length: 20 }, (_, index) => draft(index))

  const kept = appendRecoveredEditorDrafts(existing, [draft(100)])

  expect(kept).toHaveLength(20)
  expect(kept.map((entry) => entry.recoveredAt)).not.toContain(0)
  expect(kept.at(-1)?.recoveredAt).toBe(100)
})

it('drops the oldest drafts past 2 MB of text', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const big = 'x'.repeat(1024 * 1024)

  const kept = appendRecoveredEditorDrafts([draft(1, big), draft(2, big)], [draft(3, big)])

  expect(kept.map((entry) => entry.recoveredAt)).toEqual([2, 3])
})
