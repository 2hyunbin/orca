import { useSyncExternalStore } from 'react'
import {
  nativeChatComposerDraftStorage,
  parseNativeChatNewDraft,
  type NativeChatComposerDraftOwner,
  type NativeChatNewDraft
} from './native-chat-composer-draft-storage'
import { notifyScope, refusedScopes, scopeListeners } from './native-chat-composer-draft-memory'

const PREFIX = 'agent-session-new:'
const drafts = new Map<string, NativeChatNewDraft>()
const changed = new Set<string>()
const pending = new Map<string, Set<Promise<unknown>>>()
const removedOwners: NativeChatComposerDraftOwner[] = []

function broadcastNativeChatComposerDraftChange(key: string): void {
  // Persistence reads draft metadata; only a committed write needs its broadcast channel.
  void import('./native-chat-composer-draft-persistence').then((persistence) => {
    persistence.broadcastNativeChatComposerDraftChange(key)
  }).catch((error: unknown) => console.warn('[native-chat-drafts] the saved draft could not be announced', error))
}

export function nativeChatNewDraftKey(sessionId: string): string {
  return `${PREFIX}${sessionId}`
}

export function readNativeChatNewDraft(sessionId: string): NativeChatNewDraft | undefined {
  return drafts.get(nativeChatNewDraftKey(sessionId))
}

export function nativeChatNewDrafts(): [string, NativeChatNewDraft][] {
  return [...drafts].map<[string, NativeChatNewDraft]>(([key, draft]) => [key.slice(PREFIX.length), draft])
}

function notify(key: string): void {
  notifyScope(key)
  notifyScope(`agent-session:${key.slice(PREFIX.length)}`)
}

export function reportNativeChatNewDraftSaveFailure(sessionId: string, error: unknown): false {
  return failed(nativeChatNewDraftKey(sessionId), error)
}

function track(key: string, write: Promise<unknown>): void {
  const writes = pending.get(key) ?? new Set()
  pending.set(key, writes)
  writes.add(write)
  void write.then(() => {
    refusedScopes.delete(key)
    notify(key)
    broadcastNativeChatComposerDraftChange(key)
  }, (error: unknown) => failed(key, error)).finally(() => {
    writes.delete(write)
    if (!writes.size) pending.delete(key)
  })
}

function failed(key: string, error: unknown): false {
  console.warn('[native-chat-drafts] a new chat could not be saved', error)
  refusedScopes.add(key)
  notify(key)
  return false
}

export function loadNativeChatNewDraft(key: string, value: unknown, foreign = false): boolean {
  if (!key.startsWith(PREFIX)) return false
  if (pending.has(key) || (!foreign && changed.has(key))) return true
  const draft = parseNativeChatNewDraft(value)
  if (draft && removedOwners.some((owner) => owner.workspaceId === draft.owner.workspaceId && owner.executionHostId === draft.owner.executionHostId)) {
    void retireNativeChatNewDraft(key.slice(PREFIX.length))
    return true
  }
  if (draft) drafts.set(key, draft)
  else drafts.delete(key)
  notify(key)
  return true
}

export function allocateNativeChatNewDraft(sessionId: string, draft: NativeChatNewDraft): void {
  const key = nativeChatNewDraftKey(sessionId)
  changed.add(key)
  drafts.set(key, draft)
  notify(key)
  track(key, nativeChatComposerDraftStorage().write(key, draft))
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
  track(key, nativeChatComposerDraftStorage().update(key, (stored) => {
    const saved = parseNativeChatNewDraft(stored)
    return saved ? { ...saved, ...change } : null
  }))
}

export async function retireNativeChatNewDraft(sessionId: string): Promise<boolean> {
  const key = nativeChatNewDraftKey(sessionId)
  changed.add(key)
  try {
    const removed = nativeChatComposerDraftStorage().remove([key])
    track(key, removed)
    await removed
    drafts.delete(key)
    notify(key)
    broadcastNativeChatComposerDraftChange(key)
    return true
  } catch (error) {
    return failed(key, error)
  }
}

export function deleteNativeChatNewDraftsOwnedBy(owner: NativeChatComposerDraftOwner): void {
  removedOwners.push(owner)
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
  removedOwners.length = 0
}
