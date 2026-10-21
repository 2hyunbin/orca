import { mobileChatDraftStorageKey, parseMobileChatDraft } from './mobile-native-chat-draft-data'
import { mobileChatDraftStorage } from './mobile-native-chat-draft-storage'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import { useSyncExternalStore, type SetStateAction } from 'react'
import type { MobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'

// Text and its edit revision outlive the screen, including callbacks from an older mount.
type Draft = {
  text: string
  images: PendingNativeChatImage[]
  skills?: { name: string; path: string }[]
  editGeneration: number
}
const EMPTY: Draft = { text: '', images: [], editGeneration: 0 }
const textChanged = new Set<string>()
const hydrated = new Set<string>()
const hydrating = new Map<string, Promise<void>>()
const pendingWrites = new Map<string, Promise<void>>()
const deleted = new Set<string>()

const drafts = new Map<string, Draft>()
const listeners = new Set<() => void>()

// Seeded launch-context text per scope; null marks a permanent decline so a
// cleared composer never resurrects the prefill, even after leaving the screen.
export const mobileNativeChatLaunchDraftSeeds = new Map<
  string,
  MobileNativeChatLaunchDraftSeed | null
>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function writeDraft(draftKey: string, update: SetStateAction<string>, userEdit: boolean): void {
  if (deleted.has(draftKey)) {
    return
  }
  const current = drafts.get(draftKey)
  const text = current?.text ?? ''
  const next = typeof update === 'function' ? update(text) : update
  if (next === text && !userEdit) {
    return
  }
  textChanged.add(draftKey)
  drafts.set(draftKey, {
    ...(current ?? EMPTY),
    text: next,
    editGeneration: (current?.editGeneration ?? 0) + 1
  })
  save(draftKey)
  if (next === text) {
    return
  }
  for (const listener of listeners) {
    listener()
  }
}

export function setMobileNativeChatDraftText(
  draftKey: string,
  update: SetStateAction<string>
): void {
  writeDraft(draftKey, update, false)
}

export function editMobileNativeChatDraft(draftKey: string, update: SetStateAction<string>): void {
  writeDraft(draftKey, update, true)
}

export function readMobileNativeChatDraftEditGeneration(draftKey: string): number {
  return drafts.get(draftKey)?.editGeneration ?? 0
}

export function clearMobileNativeChatDraftForSend(
  draftKey: string,
  editGeneration: number,
  text: string
): void {
  const current = drafts.get(draftKey)
  if ((current?.editGeneration ?? 0) === editGeneration && (current?.text ?? '') === text) {
    textChanged.add(draftKey)
    setMobileNativeChatDraftText(draftKey, '')
  }
}

export function useMobileNativeChatDraft(draftKey: string | null): string {
  const read = (): string => (draftKey ? (drafts.get(draftKey)?.text ?? '') : '')
  return useSyncExternalStore(subscribe, read, read)
}

export function resetMobileNativeChatDraftStoreForTests(): void {
  drafts.clear()
  hydrated.clear()
  hydrating.clear()
  pendingWrites.clear()
  deleted.clear()
  textChanged.clear()
  mobileNativeChatLaunchDraftSeeds.clear()
}

export function readMobileNativeChatDraft(scope: string): Draft {
  return drafts.get(scope) ?? EMPTY
}

export function updateMobileNativeChatDraftImages(
  scope: string,
  update: (images: PendingNativeChatImage[]) => PendingNativeChatImage[]
): void {
  if (deleted.has(scope)) {
    return
  }
  const current = readMobileNativeChatDraft(scope)
  drafts.set(scope, {
    ...current,
    images: update(current.images),
    editGeneration: current.editGeneration + 1
  })
  save(scope)
  listeners.forEach((listener) => listener())
}

export function useMobileNativeChatDraftImages(scope: string | null): PendingNativeChatImage[] {
  const read = () => (scope ? readMobileNativeChatDraft(scope).images : EMPTY.images)
  return useSyncExternalStore(subscribe, read, read)
}

export function hydrateMobileNativeChatDraft(scope: string): Promise<void> {
  const storage = mobileChatDraftStorage()
  if (!storage || hydrated.has(scope)) {
    return Promise.resolve()
  }
  const held = hydrating.get(scope)
  if (held) {
    return held
  }
  const before = readMobileNativeChatDraft(scope)
  const load = storage
    .read(mobileChatDraftStorageKey(scope))
    .then((value) => {
      if (deleted.has(scope)) {
        return
      }
      const saved = parseMobileChatDraft(value)
      const current = readMobileNativeChatDraft(scope)
      hydrated.add(scope)
      if (saved) {
        const images = saved.images.map((image) => ({
          ...image,
          previewUri: image.previewUri ?? image.reference?.url ?? ''
        }))
        const text = textChanged.has(scope) ? current.text : saved.text
        drafts.set(scope, {
          ...current,
          text,
          images:
            current.images === before.images
              ? images
              : [
                  ...images.filter((image) => !current.images.some((held) => held.id === image.id)),
                  ...current.images
                ],
          skills: current.skills ?? saved.skills
        })
      }
      listeners.forEach((listener) => listener())
    })
    .finally(() => {
      hydrating.delete(scope)
    })
  hydrating.set(scope, load)
  return load
}

function save(scope: string): void {
  void persistMobileNativeChatDraft(scope).catch((error: unknown) => {
    console.warn('[mobile-chat-draft] could not save draft', error)
  })
}

/** Resolves only after the captured scope is hydrated and its latest draft has committed. */
export function persistMobileNativeChatDraft(scope: string): Promise<void> {
  const storage = mobileChatDraftStorage()
  if (!storage) {
    return Promise.resolve()
  }
  const write = (pendingWrites.get(scope) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      await hydrateMobileNativeChatDraft(scope)
      if (deleted.has(scope)) {
        return
      }
      const draft = readMobileNativeChatDraft(scope)
      const images = draft.images.map(({ previewUri, ...image }) => ({
        ...image,
        ...(/^(https?:|file:|content:)/i.test(previewUri) ? { previewUri } : {})
      }))
      await storage.write(
        mobileChatDraftStorageKey(scope),
        draft.text || images.length
          ? JSON.stringify({
              text: draft.text,
              images,
              ...(draft.skills ? { skills: draft.skills } : {})
            })
          : null
      )
    })
  pendingWrites.set(scope, write)
  void write
    .finally(() => {
      if (pendingWrites.get(scope) === write) {
        pendingWrites.delete(scope)
      }
    })
    .catch(() => undefined)
  return write
}

export async function deleteMobileNativeChatDrafts(
  hostId: string,
  workspaceId?: string
): Promise<void> {
  const scopes = [
    ...new Set([...drafts.keys(), ...hydrating.keys(), ...pendingWrites.keys()])
  ].filter((scope) => {
    const [host, workspace] = scope.split('\0')
    return host === hostId && (workspaceId === undefined || workspace === workspaceId)
  })
  for (const scope of scopes) {
    deleted.add(scope)
    drafts.delete(scope)
    hydrated.delete(scope)
  }
  listeners.forEach((listener) => listener())
  await Promise.allSettled(scopes.map((scope) => pendingWrites.get(scope)))
  await mobileChatDraftStorage()?.removeWorkspace(hostId, workspaceId)
}

export function useMobileNativeChatDraftHydrated(scope: string | null): boolean {
  const read = () => !scope || !mobileChatDraftStorage() || hydrated.has(scope)
  return useSyncExternalStore(subscribe, read, read)
}
