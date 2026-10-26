import { useSyncExternalStore } from 'react'
import { pickedSkillsInText } from '../../../../../src/shared/structured-agent-session-send-mutation'
import type { AgentJournalSkillRef } from '../../../../../src/shared/agent-session-journal-types'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import type { PendingNativeChatFile } from './mobile-native-chat-file-attachment'

export type MobileNativeChatDraftInputs = {
  images: readonly PendingNativeChatImage[]
  files: readonly PendingNativeChatFile[]
  skills: readonly AgentJournalSkillRef[]
  pending?: number
}
const empty: MobileNativeChatDraftInputs = { images: [], files: [], skills: [] }
const drafts = new Map<string, MobileNativeChatDraftInputs>()
const listeners = new Set<() => void>()
// Operations capture this object: hand-back redirects it; Cancel removes its right to publish.
export type MobileNativeChatDraftDestination = { scope: string; active: boolean }
const destinations = new Map<string, MobileNativeChatDraftDestination>()
export function mobileNativeChatDraftDestination(scope: string): MobileNativeChatDraftDestination {
  let destination = destinations.get(scope)
  if (!destination) {
    destination = { scope, active: true }
    destinations.set(scope, destination)
  }
  return destination
}
export function readMobileNativeChatDraftInputs(scope: string | null): MobileNativeChatDraftInputs {
  return scope ? (drafts.get(scope) ?? empty) : empty
}
export function updateMobileNativeChatDraftInputs(
  target: string | MobileNativeChatDraftDestination,
  update: (current: MobileNativeChatDraftInputs) => MobileNativeChatDraftInputs
): void {
  const destination = typeof target === 'string' ? mobileNativeChatDraftDestination(target) : target
  if (!destination.active) {
    return
  }
  drafts.set(destination.scope, update(readMobileNativeChatDraftInputs(destination.scope)))
  listeners.forEach((listener) => listener())
}
export function useMobileNativeChatDraftInputs(scope: string | null): MobileNativeChatDraftInputs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => readMobileNativeChatDraftInputs(scope)
  )
}
export function closeMobileNativeChatEditInputs(scope: string, to?: string): void {
  const destination = mobileNativeChatDraftDestination(scope)
  const input = readMobileNativeChatDraftInputs(scope)
  if (to) {
    updateMobileNativeChatDraftInputs(to, (current) => ({
      images: [...current.images, ...input.images.filter((image) => !image.id.startsWith('kept-'))],
      files: [...current.files, ...input.files],
      skills: [...current.skills, ...input.skills],
      pending: (current.pending ?? 0) + (input.pending ?? 0)
    }))
    destination.scope = to
  } else {
    destination.active = false
  }
  drafts.delete(scope)
  destinations.delete(scope)
  listeners.forEach((listener) => listener())
}

const textDestinations = new Map<string, (text: string) => void>()
let focusedScope: string | null = null
export function registerMobileNativeChatTextDestination(
  scope: string,
  insert: (text: string) => void
): () => void {
  textDestinations.set(scope, insert)
  return () => {
    if (textDestinations.get(scope) === insert) {
      textDestinations.delete(scope)
    }
  }
}
export function focusMobileNativeChatTextDestination(scope: string): void {
  focusedScope = scope
}
export function captureMobileNativeChatTextDestination(): ((text: string) => void) | undefined {
  return focusedScope ? textDestinations.get(focusedScope) : undefined
}

export function resetMobileNativeChatDraftInputsForTests(): void {
  drafts.clear()
  destinations.clear()
  textDestinations.clear()
  focusedScope = null
}

export function pruneMobileNativeChatDraftSkills(scope: string, text: string): void {
  const current = readMobileNativeChatDraftInputs(scope)
  const skills = pickedSkillsInText(text, current.skills)
  if (skills.length !== current.skills.length) {
    updateMobileNativeChatDraftInputs(scope, (current) => ({ ...current, skills }))
  }
}
