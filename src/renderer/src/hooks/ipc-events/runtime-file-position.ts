import type { RuntimeFileOpenPosition } from '../../../../shared/runtime-file-contracts'
import { scheduleEditorLineReveal } from '@/store/slices/editor/focus/editor-focus-reveal'
import { useAppStore } from '../../store'
import type { AppState } from '../../store/types'

function selectedEditorTab(state: AppState) {
  const worktreeId = state.activeWorktreeId
  if (!worktreeId) {
    return undefined
  }
  const group = state.groupsByWorktree[worktreeId]?.find(
    (candidate) => candidate.id === state.activeGroupIdByWorktree[worktreeId]
  )
  return state.unifiedTabsByWorktree[worktreeId]?.find(
    (tab) => tab.id === group?.activeTabId && tab.contentType === 'editor'
  )
}

export function createRuntimeFilePositionQueue(
  unsubs: (() => void)[]
): (fileId: string, position: RuntimeFileOpenPosition, focus: boolean) => void {
  let alive = true
  const pending = new Map<string, { position: RuntimeFileOpenPosition }>()

  const reveal = (fileId: string, request: { position: RuntimeFileOpenPosition }): void => {
    const { position } = request
    const store = useAppStore.getState()
    const file = store.openFiles.find((candidate) => candidate.id === fileId)
    const tab = selectedEditorTab(store)
    if (!file || !tab || tab.entityId !== fileId) {
      return
    }
    const canApply = (): boolean =>
      alive &&
      pending.get(fileId) === request &&
      useAppStore.getState().activeWorktreeId === store.activeWorktreeId &&
      selectedEditorTab(useAppStore.getState())?.id === tab.id
    scheduleEditorLineReveal(
      useAppStore.getState,
      file.filePath,
      position.line,
      position.column,
      fileId,
      {
        viewStateId: tab.id,
        canApply,
        beforePublish: () => {
          if (file.language === 'markdown') {
            useAppStore.getState().setMarkdownViewMode(fileId, 'source')
          }
        },
        onApplied: () => {
          if (pending.get(fileId) === request) {
            pending.delete(fileId)
          }
        }
      }
    )
  }

  unsubs.push(
    useAppStore.subscribe((state, previous) => {
      if (pending.size === 0) {
        return
      }
      if (state.openFiles !== previous.openFiles) {
        const openIds = new Set(state.openFiles.map((file) => file.id))
        for (const fileId of pending.keys()) {
          if (!openIds.has(fileId)) {
            pending.delete(fileId)
          }
        }
      }
      if (
        state.activeWorktreeId === previous.activeWorktreeId &&
        state.groupsByWorktree === previous.groupsByWorktree &&
        state.activeGroupIdByWorktree === previous.activeGroupIdByWorktree
      ) {
        return
      }
      const tab = selectedEditorTab(state)
      // A background open must wait for navigation, even if this file is already on screen.
      if (
        !tab ||
        (tab.id === selectedEditorTab(previous)?.id &&
          state.activeWorktreeId === previous.activeWorktreeId)
      ) {
        return
      }
      const request = pending.get(tab.entityId)
      if (request) {
        reveal(tab.entityId, request)
      }
    }),
    () => {
      alive = false
      pending.clear()
    }
  )

  return (fileId, position, focus) => {
    const request = { position }
    pending.set(fileId, request)
    if (focus) {
      reveal(fileId, request)
    }
  }
}
