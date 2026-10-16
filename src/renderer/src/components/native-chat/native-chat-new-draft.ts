import { useSyncExternalStore } from 'react'
import {
  nativeChatComposerDraftStorage,
  parseNativeChatNewDraft,
  type NativeChatComposerDraftOwner,
  type NativeChatNewDraft
} from './native-chat-composer-draft-storage'
import { notifyScope, refusedScopes, scopeListeners } from './native-chat-composer-draft-memory'
import { broadcastNativeChatComposerDraftChange } from './native-chat-composer-draft-persistence'

const PREFIX = 'agent-session-new:'
const drafts = new Map<string, NativeChatNewDraft>()
const changed = new Set<string>()
const pending = new Set<string>()

export function nativeChatNewDraftKey(sessionId: string): string {
  return `${PREFIX}${sessionId}`
}

export function readNativeChatNewDraft(sessionId: string): NativeChatNewDraft | undefined {
  return drafts.get(nativeChatNewDraftKey(sessionId))
}

function notify(key: string): void {
  notifyScope(key)
  notifyScope(`agent-session:${key.slice(PREFIX.length)}`)
}

function failed(key: string, error: unknown): false {
  console.warn('[native-chat-drafts] a new chat could not be saved', error)
  refusedScopes.add(`agent-session:${key.slice(PREFIX.length)}`)
  notify(key)
  return false
}

export function loadNativeChatNewDraft(key: string, value: unknown, foreign = false): boolean {
  if (!key.startsWith(PREFIX)) return false
  if (pending.has(key) || (!foreign && changed.has(key))) return true
  const draft = parseNativeChatNewDraft(value)
  if (draft) drafts.set(key, draft)
  else drafts.delete(key)
  notify(key)
  return true
}

export function allocateNativeChatNewDraft(sessionId: string, draft: NativeChatNewDraft): void {
  const key = nativeChatNewDraftKey(sessionId)
  changed.add(key)
  pending.add(key)
  drafts.set(key, draft)
  notify(key)
  void nativeChatComposerDraftStorage().write(key, draft).then(
    () => broadcastNativeChatComposerDraftChange(key),
    (error: unknown) => failed(key, error)
  ).finally(() => pending.delete(key))
}

export function updateNativeChatNewDraft(
  sessionId: string,
  change: Partial<Pick<NativeChatNewDraft, 'groupId' | 'options'>>
): void {
  const key = nativeChatNewDraftKey(sessionId)
  const current = drafts.get(key)
  if (!current) return
  const next = { ...current, ...change }
  changed.add(key)
  drafts.set(key, next)
  notify(key)
  // Only allocation inserts metadata, so a stale window cannot revive a retired draft.
  void nativeChatComposerDraftStorage().update(key, (stored) => {
    const saved = parseNativeChatNewDraft(stored)
    return saved ? { ...saved, ...change } : null
  }).then(() => broadcastNativeChatComposerDraftChange(key), (error: unknown) => failed(key, error))
}

export async function retireNativeChatNewDraft(sessionId: string): Promise<boolean> {
  const key = nativeChatNewDraftKey(sessionId)
  changed.add(key)
  try {
    await nativeChatComposerDraftStorage().remove([key])
    drafts.delete(key)
    notify(key)
    broadcastNativeChatComposerDraftChange(key)
    return true
  } catch (error) {
    return failed(key, error)
  }
}

export function deleteNativeChatNewDraftsOwnedBy(owner: NativeChatComposerDraftOwner): void {
  for (const [key, draft] of drafts) {
    if (draft.owner.workspaceId === owner.workspaceId && draft.owner.executionHostId === owner.executionHostId) {
      void retireNativeChatNewDraft(key.slice(PREFIX.length))
    }
  }
}

export function useNativeChatNewDraft(sessionId: string): NativeChatNewDraft | undefined {
  return useSyncExternalStore(
    (listener) => {
      const key = nativeChatNewDraftKey(sessionId)
      const listeners = scopeListeners.get(key) ?? new Set()
      scopeListeners.set(key, listeners)
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    () => readNativeChatNewDraft(sessionId)
  )
}

export function resetNativeChatNewDraftsForTests(): void {
  drafts.clear()
  changed.clear()
  pending.clear()
}
