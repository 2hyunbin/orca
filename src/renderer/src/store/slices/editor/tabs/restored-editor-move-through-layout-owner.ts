// A restored editor tab re-owned by the workspace that owns its file (F42), in a layout-owner
// build: the window sends the move (a re-own inside its workspace is a rename) under the ids it
// proposes, and the frame that shows main's move rekeys the file's content in the same update.

import type { Tab } from '../../../../../../shared/tab-types'
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { sendLayoutApply, type WindowLayoutCommand } from '@/runtime/layout-apply-send'
import {
  expectContentRekey,
  framesShowTabRekeys,
  type TabRekey
} from '@/runtime/layout-owner-content-rekeys'
import type { AppState } from '../../../types'
import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { OpenFile } from '../types/open-file'
import type {
  RestoredEditorOwnerMigration,
  RestoredEditorOwnerResult
} from '../types/restored-editor-owner'
import { resolveRestoredEditorOwnerDestination } from '../actions/restored-editor-owner-destination'
import {
  buildRestoredEditorOwnerTransition,
  restoredEditorTargetGroupId
} from '../actions/restored-editor-owner-transition'
import { restorableEditorFile } from './editor-tab-layout-owner'
import { layoutEditorViewOfOpenFile } from './open-file-layout-view'

type TabMove = { tab: Tab; newTabId: string; newEntityId: string }

const tabRekeysOf = (moves: readonly TabMove[]): TabRekey[] =>
  moves.map(({ tab, newTabId, newEntityId }) => ({
    tabId: tab.id,
    entityId: tab.entityId,
    newTabId,
    newEntityId
  }))

function moveCommand(
  args: RestoredEditorOwnerMigration,
  source: OpenFile,
  moves: readonly TabMove[],
  groupId: string,
  renamedFile: (id: string) => OpenFile | undefined,
  newFileId: string
): WindowLayoutCommand {
  const viewOf = (id: string) => {
    const file = renamedFile(id)
    const view = file && layoutEditorViewOfOpenFile(file)
    return view ? { view } : {}
  }
  // Main keeps only edit-mode files' records.
  const moved = renamedFile(newFileId)
  const record = source.mode === 'edit' && moved ? restorableEditorFile(moved) : undefined
  if (source.worktreeId === args.targetWorktreeId) {
    const renames = new Map(moves.map((move) => [move.tab.entityId, move.newEntityId]))
    return {
      type: 'renameEditorFiles',
      renames: [...renames].map(([fileId, renamedId]) => ({
        fileId,
        newFileId: renamedId,
        ...(fileId === source.id && record
          ? { record: { fromFilePath: source.filePath, file: record } }
          : {}),
        ...viewOf(renamedId)
      }))
    }
  }
  return {
    type: 'moveTabToWorkspace',
    toWorkspace: args.targetWorktreeId,
    tabs: moves.map(({ tab, newTabId, newEntityId }) => ({
      tabId: tab.id,
      newTabId,
      newEntityId,
      ...viewOf(newEntityId)
    })),
    groupId,
    ...(record ? { file: record } : {})
  }
}

/**
 * Sends the move and returns the result the window promises; null when main is not asked (the
 * move cannot be made, no tab shows the file, or a paired server owns a workspace), and the
 * caller moves it as today. `today` is that move, for a twin main routes to a paired server.
 */
export function reparentRestoredEditorThroughLayoutOwner(
  set: EditorSet,
  get: EditorGet,
  args: RestoredEditorOwnerMigration,
  activatesTarget: boolean,
  today: () => void
): RestoredEditorOwnerResult | null {
  const state = get()
  const destination = resolveRestoredEditorOwnerDestination(state, args)
  const to = args.targetWorktreeId
  if (!destination.ok || runtimeEnvironmentIdUnlessTwin(state, to)) {
    return null
  }
  const { source, newFileId, previewIdMigrations } = destination
  const from = source.worktreeId
  const migrations = new Map([[source.id, newFileId], ...previewIdMigrations])
  const moves: TabMove[] = (state.unifiedTabsByWorktree[from] ?? []).flatMap((tab) =>
    migrations.has(tab.entityId)
      ? [
          {
            tab,
            newTabId: migrations.get(tab.id) ?? tab.id,
            newEntityId: migrations.get(tab.entityId)!
          }
        ]
      : []
  )
  if (moves.length === 0) {
    return null
  }
  const groupId = restoredEditorTargetGroupId(state, to)
  const transitionOf = (s: AppState) => {
    let ok = false
    const next = buildRestoredEditorOwnerTransition(args, (result) => (ok = result.ok), groupId)(s)
    return ok ? next : null
  }
  const planned = transitionOf(state)
  if (!planned) {
    return null
  }
  const renamedFile = (id: string): OpenFile | undefined =>
    planned.patch.openFiles?.find((file) => file.id === id && file.worktreeId === to)
  const command = moveCommand(args, source, moves, groupId, renamedFile, newFileId)
  const expected = expectContentRekey(
    {
      shows: (cache) => framesShowTabRekeys(cache, from, to, tabRekeysOf(moves)),
      // Re-checked against the store the frame finds; a move gone stale rekeys nothing.
      patch: (s) => transitionOf(s)?.patch ?? {}
    },
    [...migrations.keys(), ...migrations.values()]
  )
  const sent = sendLayoutApply(state, from, command, {
    apply: () => {
      expected.applied((patch) => set(patch), get())
      if (activatesTarget) {
        get().setActiveWorktree(to, args.targetExecutionHostId, {
          // The surface the window's own move selects: the moved file's editor.
          stateTransition: (s) => ({
            patch: {
              activeTabTypeByWorktree: { ...s.activeTabTypeByWorktree, [to]: 'editor' }
            },
            activate: true,
            preferredActiveUnifiedTabId: moves.at(-1)!.newTabId
          })
        })
      }
    },
    asToday: () => {
      expected.dropped()
      today()
    },
    refused: () => {
      expected.dropped()
      get().setRestoredEditorOwnerMigrationPending(args.fileId, false)
    }
  })
  if (!sent) {
    expected.dropped()
    return null
  }
  return { ok: true, fileId: newFileId }
}
