import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { writeRuntimeFile } from '@/runtime/runtime-file-mutation-client'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import {
  canAutoSaveOpenFile,
  isAutosaveSuspendedForFile,
  normalizeAutoSaveDelayMs,
  ORCA_EDITOR_FILE_SAVED_EVENT,
  type EditorFileSavedDetail
} from './editor-autosave'
import { flushPendingEditorChange, hasPendingEditorChange } from './editor-pending-flush'
import {
  clearSelfWrite,
  recordSelfWrite,
  SELF_WRITE_REMOTE_TTL_MS
} from './editor-self-write-registry'
import { getDiskBaselineSignature } from './diff-content-signature'
import { trackExternalChangeConflictAction } from './editor-external-change-telemetry'
import { editorTabFileAccess } from '@/lib/local-file-access'
import {
  editorBufferIdOf,
  editorBufferViewIds
} from '@/store/slices/editor/buffers/editor-buffer-record'
import type { EditorBufferIdentity } from '@/store/slices/editor/buffers/editor-buffer-identity'
import {
  createEditorFileWriteLedger,
  markOtherEditorRecordsChanged
} from './editor-file-write-ledger'
import { markEditorBufferNewer } from '@/store/slices/editor/buffers/editor-buffer-read-freshness'

export type AppStoreApi = Pick<StoreApi<AppState>, 'getState' | 'subscribe'>

export type EditorSaveQueue = {
  queueSave: (
    file: OpenFile,
    fallbackContent: string,
    trigger?: 'autosave' | 'user'
  ) => Promise<void>
  quiesceFileSave: (fileId: string) => Promise<void>
  clearAutoSaveTimer: (fileId: string) => void
  bumpSaveGeneration: (fileId: string) => void
  syncAutoSave: () => void
  dispose: () => void
}

function flushPendingBufferChanges(state: AppState, fileId: string, autosave?: boolean): void {
  for (const id of editorBufferViewIds(state, fileId)) {
    flushPendingEditorChange(id, autosave)
  }
}

function hasPendingBufferChange(state: AppState, fileId: string): boolean {
  return editorBufferViewIds(state, fileId).some((id) => hasPendingEditorChange(id))
}

// Why: keeping the save queue, quiesce coordination, and the debounce timers that feed it together avoids split-brain saves.
// Generation and autosave timer are keyed by buffer record, so every tab of a file shares them; the
// queue is keyed by physical file, so records of one file kept apart never write at the same time.
export function createEditorSaveQueue(store: AppStoreApi): EditorSaveQueue {
  const autoSaveTimers = new Map<string, number>()
  const autoSaveScheduledContent = new Map<string, string>()
  const saveQueue = new Map<string, Promise<void>>()
  const saveGeneration = new Map<string, number>()
  const completedWrites = new Map<string, number>()
  const writeLedger = createEditorFileWriteLedger()

  const recordIdOf = (fileId: string): string => editorBufferIdOf(store.getState(), fileId)
  const identityOf = (recordId: string): EditorBufferIdentity | undefined =>
    store.getState().editorBufferIndex?.keyByRecordId[recordId]?.identity
  const fileQueueKeyOf = (recordId: string): string => identityOf(recordId)?.key ?? recordId

  const clearRecordAutoSaveTimer = (recordId: string): void => {
    const timerId = autoSaveTimers.get(recordId)
    if (timerId !== undefined) {
      window.clearTimeout(timerId)
      autoSaveTimers.delete(recordId)
    }
    autoSaveScheduledContent.delete(recordId)
  }

  const clearAutoSaveTimer = (fileId: string): void => clearRecordAutoSaveTimer(recordIdOf(fileId))

  const bumpSaveGeneration = (fileId: string): void => {
    const recordId = recordIdOf(fileId)
    saveGeneration.set(recordId, (saveGeneration.get(recordId) ?? 0) + 1)
  }

  const queueSave = (
    file: OpenFile,
    fallbackContent: string,
    trigger: 'autosave' | 'user' = 'user'
  ): Promise<void> => {
    const recordId = recordIdOf(file.id)
    clearRecordAutoSaveTimer(recordId)
    const queuedGeneration = saveGeneration.get(recordId) ?? 0
    const queuedAfterWrites = completedWrites.get(recordId) ?? 0
    const fileKey = fileQueueKeyOf(recordId)

    const previousSave = saveQueue.get(fileKey) ?? Promise.resolve()
    const queuedSave = previousSave
      .catch(() => undefined)
      .then(async () => {
        if ((saveGeneration.get(recordId) ?? 0) !== queuedGeneration) {
          return
        }

        const state = store.getState()
        const liveFile = state.openFiles.find((openFile) => openFile.id === file.id) ?? null
        if (!liveFile) {
          return
        }
        if (liveFile.csvPreviewOnly === true) {
          throw new Error('Large CSV previews are read-only.')
        }

        // Why: read-only tabs (AI Vault View Log) must never write the agent-owned artifact through editor paths.
        if (liveFile.readOnly === true) {
          return
        }

        if (liveFile.pendingOwnerMigration === true) {
          if (trigger === 'autosave') {
            return
          }
          throw new Error('This file is still restoring its workspace owner. Try saving again.')
        }

        // Why: only autosave is blocked while suspended; explicit user saves proceed (the banner warned).
        if (trigger === 'autosave' && isAutosaveSuspendedForFile(liveFile)) {
          return
        }

        flushPendingBufferChanges(state, file.id, trigger === 'autosave')
        const draft = store.getState().editorDrafts[file.id]
        // Why: a write since this request queued already saved newer text than its fallback.
        if (draft === undefined && (completedWrites.get(recordId) ?? 0) !== queuedAfterWrites) {
          return
        }
        const contentToSave = draft ?? fallbackContent
        if (
          trigger === 'autosave' &&
          hasPendingBufferChange(store.getState(), file.id) &&
          liveFile.lastKnownDiskSignature === getDiskBaselineSignature(contentToSave)
        ) {
          return
        }
        // Why: another record of this file wrote since this one's disk version; its edits must not
        // silently replace that write. An explicit save after the banner still overwrites.
        const identity = identityOf(recordId)
        if (
          writeLedger.isStaleWrite(fileKey, recordId, identity, liveFile.lastKnownDiskSignature) &&
          !(trigger === 'user' && liveFile.externalMutation === 'changed')
        ) {
          store.getState().setExternalMutation(liveFile.id, 'changed')
          return
        }
        const worktree = liveFile.worktreeId
          ? findWorktreeById(state.worktreesByRepo ?? {}, liveFile.worktreeId)
          : null
        const fileContext = getEditorFileOperationContext(state, liveFile, worktree?.path ?? null)
        const connectionId = fileContext.connectionId
        // Why: stamp before writing so useEditorExternalWatch ignores our own fs:changed echo (editor-self-write-registry).
        recordSelfWrite(
          liveFile.filePath,
          contentToSave,
          liveFile.runtimeEnvironmentId,
          connectionId || liveFile.runtimeEnvironmentId?.trim()
            ? SELF_WRITE_REMOTE_TTL_MS
            : undefined
        )
        try {
          await writeRuntimeFile(
            fileContext,
            liveFile.filePath,
            contentToSave,
            editorTabFileAccess(state, liveFile)
          )
        } catch (error) {
          // Why: the self-write stamp is only valid after a real write; clear on failure so it can't suppress a real update.
          clearSelfWrite(liveFile.filePath, liveFile.runtimeEnvironmentId)
          throw error
        }

        completedWrites.set(recordId, (completedWrites.get(recordId) ?? 0) + 1)
        // Why: a read of this file that started before the write must not land after it.
        markEditorBufferNewer(recordId)
        writeLedger.recordWrite(
          fileKey,
          recordId,
          identity,
          getDiskBaselineSignature(contentToSave)
        )
        if ((saveGeneration.get(recordId) ?? 0) !== queuedGeneration) {
          return
        }

        // Why the record: the tab that started the save may have closed while another still shows the file.
        const nextState = store.getState()
        const views = nextState.openFiles.filter(
          (openFile) => editorBufferIdOf(nextState, openFile.id) === recordId
        )
        const view = views.find(canAutoSaveOpenFile) ?? views[0]
        if (!view) {
          return
        }
        const currentDraft = nextState.editorDrafts[view.id]
        const stillDirty =
          (currentDraft !== undefined && currentDraft !== contentToSave) ||
          hasPendingBufferChange(nextState, view.id)
        nextState.markFileDirty(view.id, stillDirty)
        if (!stillDirty) {
          nextState.clearEditorDraft(view.id)
        }
        // Why: disk now holds contentToSave — rebaseline so our own save isn't flagged external; drop pending verification.
        nextState.setLastKnownDiskSignature(view.id, getDiskBaselineSignature(contentToSave))
        nextState.clearPendingDiskBaselineVerification(view.id)
        markOtherEditorRecordsChanged(store.getState(), recordId, identity)
        // Why: the write made disk match the buffer, so clear any now-stale changed-on-disk conflict.
        const savedFile = store.getState().openFiles.find((openFile) => openFile.id === view.id)
        if (savedFile?.externalMutation === 'changed') {
          trackExternalChangeConflictAction(savedFile, 'save_overwrite')
          nextState.setExternalMutation(view.id, null)
        }

        window.dispatchEvent(
          new CustomEvent<EditorFileSavedDetail>(ORCA_EDITOR_FILE_SAVED_EVENT, {
            detail: { fileId: view.id, content: contentToSave }
          })
        )
      })

    let trackedSave: Promise<void>
    trackedSave = queuedSave.finally(() => {
      if (saveQueue.get(fileKey) === trackedSave) {
        saveQueue.delete(fileKey)
      }
    })
    saveQueue.set(fileKey, trackedSave)
    return trackedSave
  }

  const quiesceFileSave = async (fileId: string): Promise<void> => {
    // Why: rich markdown debounces serialization, so force the pending draft out before we cancel timers.
    flushPendingBufferChanges(store.getState(), fileId)
    const recordId = recordIdOf(fileId)
    const pendingSave = saveQueue.get(fileQueueKeyOf(recordId))
    clearRecordAutoSaveTimer(recordId)
    bumpSaveGeneration(fileId)
    await pendingSave?.catch(() => undefined)
  }

  const syncAutoSave = (): void => {
    const state = store.getState()
    // One autosave candidate per record: the first tab that may write it.
    const candidates = new Map<string, OpenFile>()
    if (state.settings?.editorAutoSave) {
      for (const file of state.openFiles) {
        const recordId = editorBufferIdOf(state, file.id)
        if (
          !candidates.has(recordId) &&
          file.isDirty &&
          state.editorDrafts[file.id] !== undefined &&
          canAutoSaveOpenFile(file) &&
          // Why: suspension holds until the user picks a side via the banner (or saves manually).
          !isAutosaveSuspendedForFile(file)
        ) {
          candidates.set(recordId, file)
        }
      }
    }

    for (const recordId of Array.from(autoSaveTimers.keys())) {
      if (!candidates.has(recordId)) {
        clearRecordAutoSaveTimer(recordId)
      }
    }

    if (!state.settings?.editorAutoSave) {
      return
    }

    const autoSaveDelayMs = normalizeAutoSaveDelayMs(state.settings.editorAutoSaveDelayMs)
    for (const [recordId, file] of candidates) {
      const draft = state.editorDrafts[file.id]
      if (autoSaveTimers.has(recordId) && autoSaveScheduledContent.get(recordId) === draft) {
        continue
      }

      clearRecordAutoSaveTimer(recordId)
      autoSaveScheduledContent.set(recordId, draft)
      const timerId = window.setTimeout(() => {
        autoSaveTimers.delete(recordId)
        autoSaveScheduledContent.delete(recordId)
        // Why: the tab that scheduled it may have closed while another tab of the file stays open.
        const liveState = store.getState()
        const writer =
          liveState.openFiles.find(
            (openFile) =>
              editorBufferIdOf(liveState, openFile.id) === recordId && canAutoSaveOpenFile(openFile)
          ) ?? file
        void queueSave(writer, draft, 'autosave').catch((error) => {
          console.error('[editor] autosave failed', error)
        })
      }, autoSaveDelayMs)
      autoSaveTimers.set(recordId, timerId)
    }
  }

  const dispose = (): void => {
    for (const timerId of autoSaveTimers.values()) {
      window.clearTimeout(timerId)
    }
    autoSaveTimers.clear()
    autoSaveScheduledContent.clear()
    saveQueue.clear()
    saveGeneration.clear()
    completedWrites.clear()
    writeLedger.clear()
  }

  return {
    queueSave,
    quiesceFileSave,
    clearAutoSaveTimer,
    bumpSaveGeneration,
    syncAutoSave,
    dispose
  }
}
