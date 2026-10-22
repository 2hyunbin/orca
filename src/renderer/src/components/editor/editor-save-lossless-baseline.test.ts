import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createEditorStore } from './editor-autosave-controller-test-fixture'
import { createEditorSaveQueue } from './editor-save-queue'
import { GUARDED_PATH, openGuardedFile, stubGuardedDisk } from './editor-save-guarded-disk-fixture'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it.each(['autosave', 'restart', 'user', 'overwrite'] as const)(
  'requires a lossless baseline only for automatic writes (%s)',
  async (trigger) => {
    const decoded = Buffer.from([0x61, 0xfe]).toString('utf8')
    const newer = Buffer.from([0x61, 0xff]).toString('utf8')
    const disk = stubGuardedDisk({ [GUARDED_PATH]: newer })
    const store = createEditorStore()
    openGuardedFile(store, { baseline: decoded, draft: decoded })
    const queue = createEditorSaveQueue(store)
    try {
      const automatic = trigger === 'autosave' || trigger === 'restart'
      expect(await queue.queueSave(store.getState().openFiles[0], decoded, trigger)).toBe(
        automatic ? 'blocked-stale' : 'written'
      )
      expect(store.getState().openFiles[0]?.isDirty).toBe(automatic)
      expect(store.getState().openFiles[0]?.externalMutation).toBe(
        automatic ? 'changed' : undefined
      )
      expect(disk.files.get(GUARDED_PATH)).toBe(decoded)
    } finally {
      queue.dispose()
    }
  }
)
