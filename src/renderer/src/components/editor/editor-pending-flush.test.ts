import { expect, it, vi } from 'vitest'
import {
  flushAllPendingEditorBuffers,
  flushPendingEditorBuffer,
  hasPendingEditorBufferChange,
  registerPendingEditorFlush
} from './editor-pending-flush'
import { EMPTY_EDITOR_BUFFER_VIEW_INDEX as NO_SHARING } from '@/store/slices/editor/buffers/editor-buffer-views'

it('retains legacy replacement semantics and independently cleans up registrations', () => {
  const earlier = vi.fn()
  const later = vi.fn()
  const removeEarlier = registerPendingEditorFlush('legacy', earlier)
  const removeLater = registerPendingEditorFlush('legacy', later)
  try {
    flushPendingEditorBuffer(NO_SHARING, 'legacy')
    expect(earlier).not.toHaveBeenCalled()
    expect(later).toHaveBeenCalledTimes(1)
    removeEarlier()
    flushPendingEditorBuffer(NO_SHARING, 'legacy')
    expect(later).toHaveBeenCalledTimes(2)
  } finally {
    removeEarlier()
    removeLater()
  }
  flushPendingEditorBuffer(NO_SHARING, 'legacy')
  expect(later).toHaveBeenCalledTimes(2)
})

it('checks pending changes across panes and retains the remaining registration on cleanup', () => {
  const earlier = vi.fn()
  const later = vi.fn()
  const removeEarlier = registerPendingEditorFlush('panes', earlier, () => true)
  const removeLater = registerPendingEditorFlush('panes', later, () => false)
  try {
    expect(hasPendingEditorBufferChange(NO_SHARING, 'panes')).toBe(true)
    removeLater()
    flushPendingEditorBuffer(NO_SHARING, 'panes')
    expect(earlier).toHaveBeenCalledTimes(1)
    expect(later).not.toHaveBeenCalled()
  } finally {
    removeEarlier()
    removeLater()
  }
  expect(hasPendingEditorBufferChange(NO_SHARING, 'panes')).toBe(false)
})

it('flushes every view before a purge, leaving idle CSV cells open', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const rich = vi.fn(() => {
    throw new Error('serialize failed')
  })
  const changedCell = vi.fn()
  const idleCell = vi.fn()
  const removers = [
    registerPendingEditorFlush('rich', rich),
    registerPendingEditorFlush('changed', changedCell, () => true),
    registerPendingEditorFlush('idle', idleCell, () => false)
  ]
  try {
    flushAllPendingEditorBuffers()
    expect(rich).toHaveBeenCalledTimes(1)
    expect(changedCell).toHaveBeenCalledTimes(1)
    expect(idleCell).not.toHaveBeenCalled()
  } finally {
    removers.forEach((remove) => remove())
  }
})
