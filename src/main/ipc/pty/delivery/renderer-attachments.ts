/**
 * One record per renderer transport connection: its page, the PTY it is bound
 * to, and whether its view consumes and shows that PTY's bytes. A window spawn
 * opens the record before the provider runs; the connection's own reports
 * update the same record and its retirement closes it. Indexed by PTY for the
 * delivery hot path; a handle acts only while its exact record is registered.
 */
import type { PtySpawnOptions } from '../../../providers/pty-provider-contract'

export type RendererAttachmentState = { consuming: boolean; visible: boolean }

type RendererAttachment = RendererAttachmentState & {
  readonly id: string
  readonly page: string
  boundPtyId: string | null
}

export type RendererAttachmentBinding = {
  bind: (ptyId: string) => void
  release: () => void
}

const attachmentsById = new Map<string, RendererAttachment>()
const attachmentsByPty = new Map<string, Set<RendererAttachment>>()
// Why null-init + wrapper fn: see debug.ts — rolldown const-folds `export let fn = noop` bridges (STA-5661).
let changeImpl: ((ids: readonly string[], mutate: () => void) => void) | null = null

/** Wired by the IPC session so record changes re-derive drain, drop and pacing state. */
export function setRendererAttachmentChangeHandler(
  fn: ((ids: readonly string[], mutate: () => void) => void) | null
): void {
  changeImpl = fn
}

function change(ids: readonly (string | null)[], mutate: () => void): void {
  const affected = ids.filter((id): id is string => id !== null)
  if (changeImpl) {
    changeImpl(affected, mutate)
  } else {
    mutate()
  }
}

function setBinding(record: RendererAttachment, ptyId: string | null): void {
  if (record.boundPtyId !== null) {
    const bound = attachmentsByPty.get(record.boundPtyId)
    bound?.delete(record)
    if (bound?.size === 0) {
      attachmentsByPty.delete(record.boundPtyId)
    }
  }
  record.boundPtyId = ptyId
  if (ptyId !== null) {
    const bound = attachmentsByPty.get(ptyId) ?? new Set()
    bound.add(record)
    attachmentsByPty.set(ptyId, bound)
  }
}

function deleteRecord(record: RendererAttachment): void {
  attachmentsById.delete(record.id)
  setBinding(record, null)
}

function isLive(record: RendererAttachment): boolean {
  return attachmentsById.get(record.id) === record
}

export function openRendererAttachment(
  page: string,
  key: string,
  ptyId: string | null,
  state: RendererAttachmentState
): RendererAttachmentBinding {
  const record: RendererAttachment = { id: `${page}:${key}`, page, boundPtyId: null, ...state }
  const replaced = attachmentsById.get(record.id)
  change([replaced?.boundPtyId ?? null, ptyId], () => {
    if (replaced) {
      deleteRecord(replaced)
    }
    attachmentsById.set(record.id, record)
    setBinding(record, ptyId)
  })
  return {
    bind: (nextPtyId) => {
      if (isLive(record) && record.boundPtyId !== nextPtyId) {
        change([record.boundPtyId, nextPtyId], () => setBinding(record, nextPtyId))
      }
    },
    release: () => {
      if (isLive(record)) {
        change([record.boundPtyId], () => deleteRecord(record))
      }
    }
  }
}

/** Replaces the connection's reported state; returns its bound PTY, or undefined when no record exists. */
export function updateRendererAttachment(
  page: string,
  key: string,
  state: Partial<RendererAttachmentState>
): string | null | undefined {
  const record = attachmentsById.get(`${page}:${key}`)
  if (!record) {
    return undefined
  }
  change([record.boundPtyId], () => Object.assign(record, state))
  return record.boundPtyId
}

export function closeRendererAttachment(page: string, key: string): void {
  const record = attachmentsById.get(`${page}:${key}`)
  if (record) {
    change([record.boundPtyId], () => deleteRecord(record))
  }
}

/** A retired page's connections all end with it; the caller wraps this in one change. */
export function deleteRendererAttachmentsForPage(page: string): void {
  for (const record of attachmentsById.values()) {
    if (record.page === page) {
      deleteRecord(record)
    }
  }
}

/** PTY teardown keeps the connection so a dead-owner replacement can bind it again. */
export function unbindRendererAttachmentsForPty(ptyId: string): void {
  for (const record of attachmentsByPty.get(ptyId) ?? []) {
    setBinding(record, null)
  }
}

export function hasConsumingRendererAttachment(ptyId: string): boolean {
  for (const record of attachmentsByPty.get(ptyId) ?? []) {
    if (record.consuming) {
      return true
    }
  }
  return false
}

export function hasVisibleRendererAttachment(ptyId: string): boolean {
  for (const record of attachmentsByPty.get(ptyId) ?? []) {
    if (record.visible) {
      return true
    }
  }
  return false
}

export function getRendererAttachmentPtyIds(): string[] {
  return [...attachmentsByPty.keys()]
}

/** Daemon ids are known up front; a local id is bound as it is allocated, before activation emits. */
export function withRendererAttachmentBinding(
  spawnOptions: PtySpawnOptions,
  binding: RendererAttachmentBinding | null | undefined
): PtySpawnOptions {
  if (!binding) {
    return spawnOptions
  }
  if (spawnOptions.sessionId) {
    binding.bind(spawnOptions.sessionId)
  }
  const committed = spawnOptions.onPtySpawnCommitted
  return {
    ...spawnOptions,
    onPtySpawnCommitted: (ptyId) => {
      if (ptyId) {
        binding.bind(ptyId)
      }
      committed?.(ptyId)
    }
  }
}

export function _resetRendererAttachmentsForTest(): void {
  attachmentsById.clear()
  attachmentsByPty.clear()
}
