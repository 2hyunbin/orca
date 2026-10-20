import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import type { RekeyOpenFilesResult } from '../types/open-file-path-rekey'
import { rekeyOpenFilesPatch } from './rekey-open-files-patch'
import { renameEditorFilesThroughLayoutOwner } from '../tabs/editor-file-rename-through-layout-owner'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'

export function createRekeyOpenFilesAction(
  set: EditorSet,
  get: EditorGet
): Pick<EditorSlice, 'rekeyOpenFilesForPathChange'> {
  return {
    rekeyOpenFilesForPathChange: ({ rekeys, moveOperationId }) => {
      if (rekeys.length === 0) {
        return { ok: true }
      }
      // Switch point: main renames the tabs, and its frame rekeys the content.
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        return renameEditorFilesThroughLayoutOwner(set, get, rekeys, moveOperationId)
      }
      let result: RekeyOpenFilesResult = { ok: true }
      set((s) => {
        const next = rekeyOpenFilesPatch(s, rekeys, moveOperationId)
        if (!next.ok) {
          result = next
          return s
        }
        return next.patch
      })
      return result
    }
  }
}
