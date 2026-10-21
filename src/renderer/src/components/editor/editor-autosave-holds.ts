import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { joinPath } from '@/lib/path'
import { getOpenFilesForExternalFileChange, type EditorPathMutationTarget } from './editor-autosave'
import { editorTabModelUri } from './editor-save-disk-precondition'
import { toEditorModelUri } from './editor-model-uri'
import { resolveEditorModelOwner, resolvedEditorModelOwnerKey } from './editor-model-owner'

/** Edit tabs of one file and host share a model, its save queue, and any discard hold. */
export function editorSaveKeyOfFile(state: AppState, file: OpenFile): string {
  return file.mode === 'edit' ? editorTabModelUri(state, file) : file.id
}

/**
 * Save keys a path mutation (git discard) touches: the matched tabs' models, plus the model the
 * path maps to in the target workspace, which another workspace's tab may hold with none open here.
 */
export function pathMutationSaveKeys(
  state: AppState,
  target: EditorPathMutationTarget
): Set<string> {
  const keys = new Set(
    getOpenFilesForExternalFileChange(state.openFiles, target).map((file) =>
      editorSaveKeyOfFile(state, file)
    )
  )
  const ownerKey = resolvedEditorModelOwnerKey(
    resolveEditorModelOwner(
      {
        worktreeId: target.worktreeId,
        ...(Object.hasOwn(target, 'runtimeEnvironmentId')
          ? { runtimeEnvironmentId: target.runtimeEnvironmentId }
          : {})
      },
      state
    )
  )
  // Why: an unresolved owner keys its model per tab, so no other tab can share it.
  if (ownerKey !== null) {
    keys.add(toEditorModelUri(joinPath(target.worktreePath, target.relativePath), ownerKey))
  }
  return keys
}

// Why: a slow SSH git restore can take a while; past this the dirty tabs say why they aren't saving.
export const AUTOSAVE_HOLD_BACKSTOP_MS = 120_000

export type AutoSaveHolds = {
  /** Pauses autosave for these save keys until the returned release runs. */
  hold: (keys: ReadonlySet<string>) => () => void
  /** Whether a discard currently holds `file`'s autosave. */
  isHeld: (state: AppState, file: OpenFile) => boolean
  dispose: () => void
}

/** Autosave pauses a git discard takes on a file's models in every workspace while git runs. */
export function createAutoSaveHolds(getState: () => AppState, onChange: () => void): AutoSaveHolds {
  // Held key → number of holds on it.
  const counts = new Map<string, number>()
  const backstops = new Set<number>()
  let disposed = false

  const hold = (keys: ReadonlySet<string>): (() => void) => {
    let released = false
    const release = (): void => {
      // Why: a discard finishing after the controller detached must not re-arm its timers.
      if (released || disposed) {
        return
      }
      released = true
      window.clearTimeout(backstop)
      backstops.delete(backstop)
      for (const key of keys) {
        const count = (counts.get(key) ?? 1) - 1
        if (count > 0) {
          counts.set(key, count)
        } else {
          counts.delete(key)
        }
      }
      onChange()
    }
    // Why: git's outcome is still unknown, so the hold stays; the banner only explains the pause
    // and makes any later write an explicit choice.
    const backstop = window.setTimeout(() => {
      backstops.delete(backstop)
      const state = getState()
      for (const tab of state.openFiles) {
        if (tab.isDirty && keys.has(editorSaveKeyOfFile(state, tab))) {
          state.setExternalMutation(tab.id, 'changed')
        }
      }
    }, AUTOSAVE_HOLD_BACKSTOP_MS)
    backstops.add(backstop)
    for (const key of keys) {
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    onChange()
    return release
  }

  return {
    hold,
    isHeld: (state, file) => counts.size > 0 && counts.has(editorSaveKeyOfFile(state, file)),
    dispose: () => {
      disposed = true
      for (const backstop of backstops) {
        window.clearTimeout(backstop)
      }
      backstops.clear()
      counts.clear()
    }
  }
}
