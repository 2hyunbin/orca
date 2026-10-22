import { imageReferenceToken } from '../../../src/shared/native-chat-image-reference'
import {
  imageReferencesToPromptMarkers,
  promptMarkersToImageReferences
} from '../../../src/shared/native-chat-image-transcript-markers'
import { appendReturnedDraftText } from '../../../src/shared/returned-draft-text'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import { composerSkillOccurrences } from '../../../src/shared/composer-skill-occurrences'
import { mobileChatDraftStorageKey } from './mobile-native-chat-draft-data'
import {
  mobileChatDraftStorage,
  subscribeMobileChatDraftStorage,
  onMobileChatDraftRemoval,
  mobileChatDraftRemoving as removing
} from './mobile-native-chat-draft-storage'
import type { SetStateAction } from 'react'
import type { MobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'
export const EMPTY: Draft = { text: '', images: [], editGeneration: 0 }
export const WAIT_MS = 15_000
export type Copy = {
  draft?: Draft
  expired: boolean
  finish: (saved: boolean) => void
}
export type MobileChatDraftOwner = {
  scope: string
  logicalDraft: symbol
  storage: ReturnType<typeof mobileChatDraftStorage>
  draft: Draft
  state: 'unread' | 'recovery' | 'known'
  acknowledged: number
  error: string | null
  read?: { wait: Promise<void>; finish: () => void }
  active?: { work: Promise<void>; copy?: Copy }
  timer?: ReturnType<typeof setTimeout>
  latest: boolean
  copy?: Copy
}
export type MobileChatDraftCopy = { valid: () => boolean }
export const owners = new Map<string, MobileChatDraftOwner>()
const listeners = new Set<() => void>()
export const mobileNativeChatLaunchDraftSeeds = new Map<
  string,
  MobileNativeChatLaunchDraftSeed | null
>()
export const notify = () => listeners.forEach((listener) => listener())
export const live = (owner: MobileChatDraftOwner) =>
  owners.get(owner.scope) === owner && owner.storage === mobileChatDraftStorage()
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function activate(scope: string): MobileChatDraftOwner {
  let owner = owners.get(scope)
  if (!owner) {
    const storage = mobileChatDraftStorage()
    owner = {
      scope,
      logicalDraft: Symbol(),
      storage,
      draft: EMPTY,
      state: storage ? (removing(scope) ? 'recovery' : 'unread') : 'known',
      acknowledged: 0,
      error: null,
      latest: false
    }
    owners.set(scope, owner)
  }
  return owner
}
export function cancelTimer(owner: MobileChatDraftOwner): void {
  clearTimeout(owner.timer)
  owner.timer = undefined
}
export function retire(owner: MobileChatDraftOwner): void {
  cancelTimer(owner)
  owner.latest = false
  owner.copy?.finish(false)
  owner.read?.finish()
  owners.delete(owner.scope)
}
export function captureMobileChatDraftOwner(scope: string): MobileChatDraftOwner | undefined {
  return owners.get(scope)
}
export const mobileChatDraftOwnerLive = live
subscribeMobileChatDraftStorage(() => {
  const held = [...owners.values()]
  held.forEach(retire)
  for (const owner of held) {
    const next = activate(owner.scope)
    next.logicalDraft = owner.logicalDraft
    next.draft = owner.draft
    next.state = owner.state === 'unread' ? 'recovery' : owner.state
    next.acknowledged = owner.acknowledged
  }
  notify()
})
onMobileChatDraftRemoval((host, workspace) => {
  for (const owner of owners.values()) {
    const [h, w] = owner.scope.split('\0')
    if (h === host && (workspace === undefined || w === workspace)) {
      retire(owner)
    }
  }
  notify()
})
export function problem(owner: MobileChatDraftOwner, message: string): void {
  owner.error = message
  notify()
}
export function request(owner: MobileChatDraftOwner, deferred = false): void {
  owner.latest ||= !deferred
  cancelTimer(owner)
  if (deferred) {
    owner.timer = setTimeout(() => {
      owner.timer = undefined
      owner.latest = true
      pump(owner)
    }, 250)
  } else {
    pump(owner)
  }
}
export function replace(owner: MobileChatDraftOwner, draft: Draft, deferred = false): void {
  if (!live(owner)) {
    return
  }
  owner.draft = draft
  request(owner, deferred)
  notify()
}
export function pump(owner: MobileChatDraftOwner): void {
  const storage = owner.storage
  if (
    !live(owner) ||
    !storage ||
    owner.state !== 'known' ||
    removing(owner.scope) ||
    owner.active
  ) {
    return
  }
  const copy = owner.copy?.draft && !owner.copy.expired ? owner.copy : undefined
  if (!copy && !owner.latest) {
    return
  }
  const draft = copy?.draft ?? owner.draft
  owner.latest = false
  const images = draft.images.map(({ previewUri, ...image }) => ({
    ...image,
    ...(/^(https?:|file:|content:)/i.test(previewUri) ? { previewUri } : {})
  }))
  const work = (async () =>
    storage.write(
      mobileChatDraftStorageKey(owner.scope),
      draft.text || images.length
        ? JSON.stringify({
            text: draft.text,
            images,
            ...(draft.skills ? { skills: draft.skills } : {})
          })
        : null
    ))()
  const settled = work
    .then(
      () => {
        if (!live(owner)) {
          return
        }
        owner.acknowledged = draft.editGeneration
        owner.error = null
        if (copy) {
          copy.finish(!copy.expired)
        }
      },
      (error: unknown) => {
        if (live(owner)) {
          owner.latest = false
          copy?.finish(false)
          if (!copy) {
            problem(
              owner,
              'Your changes are not saved yet. You can still send them. Edit or reopen the chat to try saving again.'
            )
          }
        }
        throw error
      }
    )
    .finally(() => {
      owner.active = undefined
      if (owner.copy === copy) {
        owner.copy = undefined
      }
      if (live(owner)) {
        pump(owner)
        notify()
      }
    })
  owner.active = { work: settled, copy }
  void settled.catch(() => undefined)
}
export function writeDraft(
  owner: MobileChatDraftOwner,
  update: SetStateAction<string>,
  userEdit: boolean
): void {
  if (!live(owner)) {
    return
  }
  const current = owner.draft
  const text = typeof update === 'function' ? update(current.text) : update
  replace(
    owner,
    {
      ...current,
      text,
      ...(userEdit
        ? { skills: composerSkillOccurrences(text, current.skills ?? []).map(({ ref }) => ref) }
        : {}),
      editGeneration: current.editGeneration + 1
    },
    true
  )
}

export type Draft = {
  text: string
  images: PendingNativeChatImage[]
  skills?: { name: string; path: string }[]
  editGeneration: number
}
export function combine(
  current: Draft,
  addition: Pick<Draft, 'text' | 'images' | 'skills'>,
  recovery = false
): Draft {
  const images = [...current.images]
  let text = promptMarkersToImageReferences(
    addition.text,
    addition.images.map((image) => image.id)
  )
  for (const image of addition.images) {
    const collision = images.find((held) => held.id === image.id)
    if (collision && JSON.stringify(collision) === JSON.stringify(image)) {
      continue
    }
    const id = collision ? `${image.id}-${current.editGeneration}-${images.length}` : image.id
    text = text.replaceAll(imageReferenceToken(image.id), imageReferenceToken(id))
    images.push({ ...image, id })
  }
  const original = promptMarkersToImageReferences(
    current.text,
    current.images.map((image) => image.id)
  )
  return {
    text: imageReferencesToPromptMarkers(
      recovery
        ? original && text
          ? `${original}\n\n${text}`
          : original + text
        : appendReturnedDraftText(original, text, 'append-repeated'),
      images.map((image) => image.id)
    ),
    images,
    skills: [
      ...composerSkillOccurrences(current.text, current.skills ?? []).map(({ ref }) => ref),
      ...composerSkillOccurrences(addition.text, addition.skills ?? []).map(({ ref }) => ref)
    ],
    editGeneration: current.editGeneration + 1
  }
}
