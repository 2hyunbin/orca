import {
  selectedNativeChatTab,
  selectedNativeChatInputIsReady,
  awaitSelectedNativeChatInput
} from './native-chat-input-readiness'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { shouldPreserveEditableFocus } from '../terminal-pane/pane-helpers'
import { NativeChatPasteRequest } from '@/lib/native-chat-paste-request'
import { pasteTextIntoTextControl } from '@/lib/text-control-paste'
import { useCallback, useContext, useLayoutEffect, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { structuredAgentSessionOwnerForTab } from '@/runtime/structured-agent-session-owner'
import { selectIdsBeyondHotRetain } from '../terminal-pane/terminal-hidden-view-parking'
import { NativeChatViewIdentity, retireNativeChatViewState } from './native-chat-view-state-memory'

export const NATIVE_CHAT_COLD_PARK_DELAY_MS = 30_000
export const NATIVE_CHAT_HOT_RETAIN_MS = 300_000
export const NATIVE_CHAT_HOT_RETAIN_LIMIT = 6
type View = {
  tabId: string
  visible: boolean
  admitted: boolean
  hiddenSinceMs: number | null
  lastActivatedSeq: number
  leases: number
}
const views = new Map<string, View>()
const listeners = new Set<() => void>()
let sequence = 0
let timer: ReturnType<typeof setTimeout> | undefined
export function nativeChatViewKey(tabId: string, host: string | null, sessionId: string): string {
  return JSON.stringify([tabId, host, sessionId])
}
function recompute(): void {
  clearTimeout(timer)
  const nowMs = Date.now()
  const eligible = [...views].flatMap(([id, view]) =>
    view.admitted &&
    !view.visible &&
    !view.leases &&
    view.hiddenSinceMs !== null &&
    nowMs - view.hiddenSinceMs >= NATIVE_CHAT_COLD_PARK_DELAY_MS
      ? [{ id, hiddenSinceMs: view.hiddenSinceMs, lastActivatedSeq: view.lastActivatedSeq }]
      : []
  )
  const parked = selectIdsBeyondHotRetain(eligible, {
    nowMs,
    hotRetainMs: NATIVE_CHAT_HOT_RETAIN_MS,
    hotRetainLimit: NATIVE_CHAT_HOT_RETAIN_LIMIT
  })
  for (const id of parked) {
    const view = views.get(id)
    if (view) {
      view.admitted = false
    }
  }
  let deadline = Infinity
  for (const view of views.values()) {
    if (!view.admitted || view.visible || view.leases || view.hiddenSinceMs === null) {
      continue
    }
    const age = nowMs - view.hiddenSinceMs
    const delay =
      age < NATIVE_CHAT_COLD_PARK_DELAY_MS
        ? NATIVE_CHAT_COLD_PARK_DELAY_MS
        : NATIVE_CHAT_HOT_RETAIN_MS
    if (age < delay) {
      deadline = Math.min(deadline, view.hiddenSinceMs + delay)
    }
  }
  if (Number.isFinite(deadline)) {
    timer = setTimeout(recompute, Math.max(1, deadline - nowMs))
  }
  for (const listener of listeners) {
    listener()
  }
}
let watching = false
function watchRetirement(): void {
  if (watching) {
    return
  }
  watching = true
  const coldDestination = () => {
    const tab = selectedNativeChatTab()
    if (!tab || shouldPreserveEditableFocus(document.activeElement)) {
      return false
    }
    return !selectedNativeChatInputIsReady()
  }
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.defaultPrevented || event.isComposing || !coldDestination()) {
        return
      }
      const find = keybindingMatchesAction(
        'chat.find',
        event,
        getShortcutPlatform(),
        useAppStore.getState().keybindings
      )
      const typing = event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey
      if (!find && !typing) {
        return
      }
      event.preventDefault()
      void awaitSelectedNativeChatInput().then((input) => {
        if (typing && (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
          void pasteTextIntoTextControl(input, event.key, { inputType: 'insertText' })
        } else if (input) {
          input.closest('[data-native-chat-root]')?.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: event.key,
              code: event.code,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              altKey: event.altKey,
              shiftKey: event.shiftKey,
              bubbles: true,
              cancelable: true
            })
          )
        }
      })
    },
    true
  )
  window.addEventListener(
    'paste',
    (event) => {
      if (event.defaultPrevented || !coldDestination()) {
        return
      }
      const accepted = new ClipboardEvent('paste', {
        clipboardData: event.clipboardData,
        cancelable: true
      })
      event.preventDefault()
      void awaitSelectedNativeChatInput().then((input) => {
        if (input) {
          input.focus({ preventScroll: true })
          input.dispatchEvent(new NativeChatPasteRequest(accepted))
        }
      })
    },
    true
  )
  useAppStore.subscribe((state, previous) => {
    if (state.unifiedTabsByWorktree === previous.unifiedTabsByWorktree) {
      return
    }
    const identities = new Set(
      Object.values(state.unifiedTabsByWorktree).flatMap((tabs) =>
        tabs
          .filter((tab) => tab.contentType === 'agent-session')
          .map((tab) =>
            nativeChatViewKey(tab.id, structuredAgentSessionOwnerForTab(state, tab), tab.entityId)
          )
      )
    )
    for (const key of views.keys()) {
      if (!identities.has(key)) {
        views.delete(key)
        retireNativeChatViewState(key)
      }
    }
    recompute()
  })
}
export function useNativeChatViewAdmission(key: string, tabId: string, visible: boolean): boolean {
  useLayoutEffect(() => {
    watchRetirement()
    for (const [oldKey, previous] of views) {
      if (previous.tabId === tabId && oldKey !== key) {
        views.delete(oldKey)
        retireNativeChatViewState(oldKey)
      }
    }
    let view = views.get(key)
    if (!view) {
      view = {
        tabId,
        visible,
        admitted: visible,
        hiddenSinceMs: null,
        lastActivatedSeq: 0,
        leases: 0
      }
      views.set(key, view)
    }
    if (visible) {
      view.admitted = true
      if (!view.visible || view.lastActivatedSeq === 0) {
        view.lastActivatedSeq = ++sequence
      }
      view.hiddenSinceMs = null
    } else if (view.visible) {
      view.hiddenSinceMs = Date.now()
    }
    view.visible = visible
    recompute()
    return () => {
      view.visible = false
      if (view.admitted && view.hiddenSinceMs === null) {
        view.hiddenSinceMs = Date.now()
      }
      recompute()
    }
  }, [key, tabId, visible])
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return useSyncExternalStore(subscribe, () => visible || views.get(key)?.admitted === true)
}
export function useNativeChatViewLease(): () => () => void {
  const key = useContext(NativeChatViewIdentity)
  return useCallback(() => {
    const view = key === null ? undefined : views.get(key.split('\0')[0] ?? key)
    if (!view) {
      return () => {}
    }
    view.leases += 1
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      view.leases -= 1
      recompute()
    }
  }, [key])
}

export function holdNativeChatInput(element: Element | null): () => void {
  const tabId = element
    ?.closest('[data-structured-agent-session-overlay-tab-id]')
    ?.getAttribute('data-structured-agent-session-overlay-tab-id')
  const view = [...views.values()].find((entry) => entry.tabId === tabId)
  if (!view) {
    return () => {}
  }
  view.leases += 1
  let released = false
  return () => {
    if (!released) {
      released = true
      view.leases -= 1
      recompute()
    }
  }
}
