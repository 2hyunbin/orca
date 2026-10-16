import { useSyncExternalStore } from 'react'
import { getAuthoritativelyRemovedWorktreeIds } from '@/store/slices/worktrees/listing/authoritative-worktree-removal-memory'
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
const pending = new Map<string, Promise<NativeChatNewDraft | null>>()
const invalidated = new Set<string>()
const revisions = new Map<string, symbol>()
const reading = new Set<string>()
const unsavedAllocations = new Set<string>()

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

function adopt(key: string, draft: NativeChatNewDraft | null): void {
  if (draft && getAuthoritativelyRemovedWorktreeIds(draft.owner.executionHostId)?.has(draft.owner.workspaceId)) {
    void retireNativeChatNewDraft(key.slice(PREFIX.length))
    return
  }
  if (draft) {
    unsavedAllocations.delete(key)
    drafts.set(key, draft)
  } else if (!unsavedAllocations.has(key)) {
    drafts.delete(key)
  }
  notify(key)
}

function reconcile(key: string): void {
  if (pending.has(key) || reading.has(key) || !invalidated.has(key)) {
    return
  }
  const revision = revisions.get(key)
  invalidated.delete(key)
  reading.add(key)
  void nativeChatComposerDraftStorage().read(key).then((value) => {
    reading.delete(key)
    if (revision !== revisions.get(key) || pending.has(key)) {
      invalidated.add(key)
    } else {
      adopt(key, parseNativeChatNewDraft(value))
    }
    reconcile(key)
  }, (error: unknown) => {
    reading.delete(key)
    invalidated.add(key)
    failed(key, error)
  })
}

/** Foreign messages invalidate; the owner reads after local transactions have drained. */
export function invalidateNativeChatNewDraft(key: string): boolean {
  if (!key.startsWith(PREFIX)) {
    return false
  }
  revisions.set(key, Symbol())
  invalidated.add(key)
  reconcile(key)
  return true
}

function track(key: string, apply: () => Promise<NativeChatNewDraft | null>): Promise<boolean> {
  changed.add(key)
  revisions.set(key, Symbol())
  const previous = pending.get(key)
  const write = (previous ? previous.catch(() => null) : Promise.resolve()).then(apply)
  pending.set(key, write)
  return write.then((draft) => {
    refusedScopes.delete(key)
    broadcastNativeChatComposerDraftChange(key)
    if (pending.get(key) === write) {
      adopt(key, draft)
    }
    return true
  }, (error: unknown) => failed(key, error)).finally(() => {
    if (pending.get(key) === write) {
      pending.delete(key)
      reconcile(key)
    }
  })
}

function failed(key: string, error: unknown): false {
  console.warn('[native-chat-drafts] a new chat could not be saved', error)
  refusedScopes.add(key)
  notify(key)
  return false
}

export function loadNativeChatNewDraft(key: string, value: unknown, foreign = false): boolean {
  if (foreign) {
    return invalidateNativeChatNewDraft(key)
  }
  if (!key.startsWith(PREFIX)) {
    return false
  }
  if (!changed.has(key)) {
    adopt(key, parseNativeChatNewDraft(value))
  }
  return true
}

export function allocateNativeChatNewDraft(sessionId: string, draft: NativeChatNewDraft): void {
  const key = nativeChatNewDraftKey(sessionId)
  unsavedAllocations.add(key)
  drafts.set(key, draft)
  notify(key)
  void track(key, async () => {
    await nativeChatComposerDraftStorage().write(key, draft)
    unsavedAllocations.delete(key)
    return draft
  })
}

export function updateNativeChatNewDraft(
  sessionId: string,
  change: Partial<Pick<NativeChatNewDraft, 'groupId' | 'options'>>
): void {
  const key = nativeChatNewDraftKey(sessionId)
  const current = drafts.get(key)
  if (!current) {
    return
  }
  const next = { ...current, ...change }
  drafts.set(key, next)
  notify(key)
  // Only allocation inserts metadata, so a stale window cannot revive a retired draft.
  void track(key, async () => parseNativeChatNewDraft(await nativeChatComposerDraftStorage().update(key, (stored) => {
    const saved = parseNativeChatNewDraft(stored)
    return saved ? { ...saved, ...change } : null
  })))
}

export async function retireNativeChatNewDraft(sessionId: string): Promise<boolean> {
  const key = nativeChatNewDraftKey(sessionId)
  return track(key, async () => {
    await nativeChatComposerDraftStorage().remove([key])
    unsavedAllocations.delete(key)
    return null
  })
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
  invalidated.clear()
  revisions.clear()
  reading.clear()
  unsavedAllocations.clear()
}
