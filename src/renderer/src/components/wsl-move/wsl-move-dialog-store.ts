/**
 * The WSL move dialog's state: preview → running → result. Main runs the move and owns every
 * decision; this only follows it.
 *
 * Why a standalone store, not `activeModal`: any `openModal` would evict a running move's dialog,
 * and with it the reload prompt a committed move needs.
 */
import { create } from 'zustand'
import type {
  WslMovePreview,
  WslMoveProgressEvent,
  WslMoveRequest,
  WslMoveResult,
  WslMoveRowRef,
  WslMoveUnfinished
} from '../../../../shared/wsl-move/wsl-move-driver-types'
import {
  requestLazyChunkRecoveryReload,
  type LazyChunkRecoveryReloadOutcome
} from '@/lib/lazy-chunk-recovery-reload'

/** Projects listed with a checkbox; from main's whole-distro preview, or the catalog fallback. */
export type WslMoveCandidates = { repoIds: string[]; folderWorkspaceIds: string[] }

export type WslMoveDialogState =
  | { stage: 'closed' }
  | { stage: 'loading'; distro: string }
  | {
      stage: 'preview'
      distro: string
      candidates: WslMoveCandidates
      /** The whole-distro preview, for what it lists beside the candidates. */
      distroPreview: WslMovePreview
      selected: WslMoveRowRef[]
      /** The preview of `selected`; null while it is being checked. */
      preview: WslMovePreview | null
    }
  | {
      stage: 'running'
      distro: string
      selected: WslMoveRowRef[]
      progress: WslMoveProgressEvent | null
      cancel: 'idle' | 'requested' | 'too-late'
    }
  | {
      stage: 'result'
      distro: string
      selected: WslMoveRowRef[]
      result: WslMoveResult
      reload: 'idle' | 'reloading' | LazyChunkRecoveryReloadOutcome
    }

export type WslMoveOpenRequest = {
  distro: string
  /** Opened from one project: only it starts checked. Otherwise every project does. */
  only?: WslMoveRowRef
  /** Fallback list when main refuses the whole-distro preview. */
  catalogCandidates?: () => WslMoveCandidates
}

type Store = {
  dialog: WslMoveDialogState
  unfinished: WslMoveUnfinished[]
}

export const useWslMoveDialogStore = create<Store>()(() => ({
  dialog: { stage: 'closed' },
  unfinished: []
}))

const setDialog = (dialog: WslMoveDialogState): void => {
  useWslMoveDialogStore.setState({ dialog })
}
const getDialog = (): WslMoveDialogState => useWslMoveDialogStore.getState().dialog

// Each preview request bumps this; a reply to an older one is dropped.
let previewToken = 0

// A refusal a smaller selection may avoid; the checkboxes stay so the user can narrow it.
const SCOPE_DEPENDENT_REFUSALS = new Set<string>([
  'wsl_move_export_incomplete',
  'wsl_move_manifest_too_large',
  'wsl_move_scope_changed'
])

function requestOf(distro: string, selected: readonly WslMoveRowRef[]): WslMoveRequest {
  return {
    distro,
    repoIds: selected.filter((ref) => ref.kind === 'repo').map((ref) => ref.id),
    folderWorkspaceIds: selected.filter((ref) => ref.kind === 'folder').map((ref) => ref.id)
  }
}

function refsOf(candidates: WslMoveCandidates): WslMoveRowRef[] {
  return [
    ...candidates.repoIds.map((id) => ({ kind: 'repo' as const, id })),
    ...candidates.folderWorkspaceIds.map((id) => ({ kind: 'folder' as const, id }))
  ]
}

function refusedPreview(detail: string): WslMovePreview {
  return { outcome: 'refused', code: 'wsl_move_unavailable', detail }
}

async function previewOf(request: WslMoveRequest): Promise<WslMovePreview> {
  try {
    return await window.api.wslMove.preview(request)
  } catch (error) {
    console.warn('[wsl-move] Preview failed:', error)
    return refusedPreview('preview-failed')
  }
}

function isBusy(dialog: WslMoveDialogState): boolean {
  return dialog.stage === 'running' || (dialog.stage === 'result' && mustReload(dialog.result))
}

/** A result this window must reload after: its stores were rewritten under it. */
export function mustReload(result: WslMoveResult): boolean {
  return (
    result.outcome === 'moved' ||
    (result.outcome === 'refused' && result.code === 'wsl_move_finished_earlier_move')
  )
}

export async function openWslMoveDialog(request: WslMoveOpenRequest): Promise<void> {
  // A running move, or one waiting on its reload, keeps the dialog until it is done.
  if (isBusy(getDialog())) {
    return
  }
  const token = ++previewToken
  setDialog({ stage: 'loading', distro: request.distro })
  const distroPreview = await previewOf({ distro: request.distro })
  if (token !== previewToken || getDialog().stage !== 'loading') {
    return
  }
  let candidates: WslMoveCandidates = { repoIds: [], folderWorkspaceIds: [] }
  if (distroPreview.outcome === 'ready') {
    candidates = {
      repoIds: distroPreview.repoIds,
      folderWorkspaceIds: distroPreview.folderWorkspaceIds
    }
  } else if (SCOPE_DEPENDENT_REFUSALS.has(distroPreview.code) && request.catalogCandidates) {
    candidates = request.catalogCandidates()
  }
  const all = refsOf(candidates)
  const only = request.only
  const selected =
    only && all.some((ref) => ref.kind === only.kind && ref.id === only.id) ? [only] : all
  const wholeDistro = selected.length === all.length && distroPreview.outcome === 'ready'
  setDialog({
    stage: 'preview',
    distro: request.distro,
    candidates,
    distroPreview,
    selected,
    preview: wholeDistro || all.length === 0 ? distroPreview : null
  })
  if (!wholeDistro && all.length > 0) {
    await recheckWslMove()
  }
}

/** Previews the current selection again, e.g. after a blocker cleared or the selection changed. */
export async function recheckWslMove(): Promise<void> {
  const dialog = getDialog()
  if (dialog.stage !== 'preview') {
    return
  }
  const token = ++previewToken
  setDialog({ ...dialog, preview: null })
  if (dialog.selected.length === 0) {
    return
  }
  const preview = await previewOf(requestOf(dialog.distro, dialog.selected))
  const now = getDialog()
  if (token === previewToken && now.stage === 'preview') {
    setDialog({ ...now, preview })
  }
}

export function setWslMoveSelection(selected: WslMoveRowRef[]): void {
  const dialog = getDialog()
  if (dialog.stage !== 'preview') {
    return
  }
  setDialog({ ...dialog, selected })
  void recheckWslMove()
}

export function skipWslMoveProjects(skipped: readonly WslMoveRowRef[]): void {
  const dialog = getDialog()
  if (dialog.stage !== 'preview') {
    return
  }
  setWslMoveSelection(
    dialog.selected.filter((ref) => !skipped.some((s) => s.kind === ref.kind && s.id === ref.id))
  )
}

export async function startWslMove(): Promise<void> {
  const dialog = getDialog()
  if (dialog.stage !== 'preview' || dialog.selected.length === 0) {
    return
  }
  const { distro, selected } = dialog
  ++previewToken
  setDialog({ stage: 'running', distro, selected, progress: null, cancel: 'idle' })
  const unsubscribe = window.api.wslMove.onProgress((progress) => {
    const now = getDialog()
    if (now.stage === 'running' && progress.distro === distro) {
      setDialog({ ...now, progress })
    }
  })
  let result: WslMoveResult
  try {
    result = await window.api.wslMove.start(requestOf(distro, selected))
  } catch (error) {
    // The IPC itself failed; main's own failures arrive as results.
    console.warn('[wsl-move] Start failed:', error)
    result = { outcome: 'refused', code: 'wsl_move_unavailable', detail: 'start-failed' }
  } finally {
    unsubscribe()
  }
  if (result.outcome === 'reset' || result.outcome === 'waiting-for-host') {
    console.warn(`[wsl-move] ${result.outcome}: ${result.detail}`)
  }
  setDialog({ stage: 'result', distro, selected, result, reload: 'idle' })
  void refreshWslMoveUnfinished()
}

/** Main honours a cancel only until it asks the host to commit. */
export async function cancelWslMove(): Promise<void> {
  const dialog = getDialog()
  if (dialog.stage !== 'running' || dialog.cancel !== 'idle') {
    return
  }
  setDialog({ ...dialog, cancel: 'requested' })
  const stopped = await window.api.wslMove.cancel(dialog.distro).catch(() => false)
  const now = getDialog()
  if (!stopped && now.stage === 'running') {
    setDialog({ ...now, cancel: 'too-late' })
  }
}

/** Reload through restart preparation, which backs up unsaved editors first. */
export async function reloadAfterWslMove(): Promise<void> {
  const dialog = getDialog()
  if (dialog.stage !== 'result' || dialog.reload === 'reloading') {
    return
  }
  setDialog({ ...dialog, reload: 'reloading' })
  // Resolves only when the reload was refused; a landed reload replaces this document.
  const outcome = await requestLazyChunkRecoveryReload(window)
  const now = getDialog()
  if (now.stage === 'result') {
    setDialog({ ...now, reload: outcome })
  }
}

/** Back to the projects list with the same selection, e.g. after a refusal. */
export async function reviewWslMoveAgain(): Promise<void> {
  const dialog = getDialog()
  if (dialog.stage !== 'result' || mustReload(dialog.result)) {
    return
  }
  const only = dialog.selected.length === 1 ? dialog.selected[0] : undefined
  await openWslMoveDialog({ distro: dialog.distro, only })
  const reopened = getDialog()
  // Keep a multi-project selection the user made, within what is still listed.
  if (reopened.stage === 'preview' && !only) {
    const listed = refsOf(reopened.candidates)
    const kept = dialog.selected.filter((ref) =>
      listed.some((c) => c.kind === ref.kind && c.id === ref.id)
    )
    if (kept.length !== reopened.selected.length) {
      setWslMoveSelection(kept)
    }
  }
}

export function closeWslMoveDialog(): void {
  if (isBusy(getDialog())) {
    return
  }
  ++previewToken
  setDialog({ stage: 'closed' })
}

/** Committed moves whose automations the host has not turned back on yet. */
export async function refreshWslMoveUnfinished(): Promise<void> {
  try {
    const unfinished = await window.api.wslMove.listUnfinished()
    useWslMoveDialogStore.setState({ unfinished })
  } catch (error) {
    console.warn('[wsl-move] Could not list unfinished moves:', error)
  }
}
