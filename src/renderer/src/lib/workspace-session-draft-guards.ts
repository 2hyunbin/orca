import type { OpenFile } from '@/store/slices/editor'
import type { PersistedOpenFile } from '../../../shared/workspace-session-state-types'

/** Fields that travel with a hot-exit draft so restore cannot let autosave clobber disk. */
export function getDraftAutosaveGuardFields(
  file: Pick<OpenFile, 'lastKnownDiskSignature' | 'autosavePausedAfterReloadUndo'>
): Pick<PersistedOpenFile, 'lastKnownDiskSignature' | 'autosavePausedAfterReloadUndo'> {
  return {
    // Why: restore re-derives a changed-on-disk conflict before autosave clobbers an offline agent write.
    ...(file.lastKnownDiskSignature ? { lastKnownDiskSignature: file.lastKnownDiskSignature } : {}),
    // Why: an undone reload's text must still wait for an explicit save after restart.
    ...(file.autosavePausedAfterReloadUndo !== undefined
      ? { autosavePausedAfterReloadUndo: true }
      : {})
  }
}
