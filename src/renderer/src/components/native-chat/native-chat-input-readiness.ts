import { useAppStore } from '@/store'
import { shouldPreserveEditableFocus } from '@/components/terminal-pane/pane-helpers'

const readyInputs = new Map<string, () => HTMLElement | null>()
const awaitingInputs = new Map<string, Set<(input: HTMLElement | null | false) => void>>()

export function selectedNativeChatTab() {
  const state = useAppStore.getState()
  const worktree = state.activeWorktreeId
  if (!worktree) {
    return undefined
  }
  const group = state.groupsByWorktree[worktree]?.find(
    (entry) => entry.id === state.activeGroupIdByWorktree[worktree]
  )
  const tab = state.unifiedTabsByWorktree[worktree]?.find(
    (entry) => entry.id === group?.activeTabId
  )
  return tab?.contentType === 'agent-session' ? tab : undefined
}

export function selectedNativeChatInputIsReady(): boolean {
  const tab = selectedNativeChatTab()
  return tab !== undefined && readyInputs.get(tab.id)?.() != null
}

/** A selected cold chat owns the request before an absent DOM target can fall through. */
export async function awaitSelectedNativeChatInput(): Promise<HTMLElement | null | false> {
  const tab = selectedNativeChatTab()
  const worktree = tab?.worktreeId
  if (!tab || !worktree) {
    return null
  }
  const active = document.activeElement
  if (shouldPreserveEditableFocus(active)) {
    return null
  }
  const ready = readyInputs.get(tab.id)?.()
  if (ready) {
    return ready
  }
  return new Promise((resolve) => {
    const pending = awaitingInputs.get(tab.id) ?? new Set()
    const finish = (input: HTMLElement | null | false) => {
      pending.delete(finish)
      if (pending.size === 0) {
        awaitingInputs.delete(tab.id)
      }
      stop()
      document.removeEventListener('pointerdown', cancel, true)
      document.removeEventListener('keydown', cancelForTab, true)
      resolve(input)
    }
    const cancel = () => finish(false)
    const cancelForTab = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        cancel()
      }
    }
    document.addEventListener('pointerdown', cancel, true)
    document.addEventListener('keydown', cancelForTab, true)
    awaitingInputs.set(tab.id, pending)
    pending.add(finish)
    const stop = useAppStore.subscribe((next) => {
      const selected = next.unifiedTabsByWorktree[worktree]?.find((entry) => entry.id === tab.id)
      const focused = next.groupsByWorktree[worktree]?.find(
        (entry) => entry.id === next.activeGroupIdByWorktree[worktree]
      )
      if (
        next.activeWorktreeId !== worktree ||
        focused?.activeTabId !== tab.id ||
        selected?.entityId !== tab.entityId ||
        selected?.executionHostId !== tab.executionHostId
      ) {
        finish(false)
      }
    })
  })
}

export function registerNativeChatReadyInput(
  tabId: string,
  input: () => HTMLElement | null
): () => void {
  readyInputs.set(tabId, input)
  const ready = input()
  if (ready) {
    const pending = awaitingInputs.get(tabId)
    awaitingInputs.delete(tabId)
    for (const resolve of pending ?? []) {
      resolve(ready)
    }
  }
  return () => {
    if (readyInputs.get(tabId) === input) {
      readyInputs.delete(tabId)
    }
  }
}
