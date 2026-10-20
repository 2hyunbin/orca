import { expect, it } from 'vitest'
import {
  beginEditorBufferRead,
  isEditorBufferReadCurrent,
  markEditorBufferNewer
} from './editor-buffer-read-freshness'

it("an older read can't land after a newer reload of the same file from another panel", () => {
  const panelARead = beginEditorBufferRead('record-1')
  // Disk changes; panel B reloads.
  const panelBReload = beginEditorBufferRead('record-1')

  expect(isEditorBufferReadCurrent('record-1', panelARead)).toBe(false)
  // Publishing A's result would not have moved the counter, so B's newer read still lands.
  expect(isEditorBufferReadCurrent('record-1', panelBReload)).toBe(true)
})

it("a read that started before a save can't land after it", () => {
  const read = beginEditorBufferRead('record-2')
  markEditorBufferNewer('record-2')

  expect(isEditorBufferReadCurrent('record-2', read)).toBe(false)
})

it("one file's reads don't supersede another's", () => {
  const read = beginEditorBufferRead('record-3')
  beginEditorBufferRead('record-4')

  expect(isEditorBufferReadCurrent('record-3', read)).toBe(true)
})
