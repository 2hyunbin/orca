import type { OpenFile } from '@/store/slices/editor'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { mergeRelativePaths } from './editor-external-watch-scope'
import type { EditorExternalWatchTargetState } from './editor-external-watch-targets'

export function getOpenFileRuntimeOwner(
  file: Pick<OpenFile, 'runtimeEnvironmentId'>
): string | null {
  return file.runtimeEnvironmentId?.trim() || null
}

export type WatchConsumer = {
  owner: string | null
  hostId: ExecutionHostId | null
  // Why: null means a consumer (the sidebar) that needs the whole tree.
  relativePaths: string[] | null
}

/** The host an open file was opened on; never the current selection, which may name another host's same-id workspace. */
export function getOpenFileWatchConsumer(
  file: Pick<
    OpenFile,
    'externalSshTargetId' | 'operationProvenance' | 'runtimeEnvironmentId' | 'relativePath'
  >
): WatchConsumer {
  const owner = getOpenFileRuntimeOwner(file)
  const capturedHostId = file.operationProvenance?.generation.route.executionHostId
  return {
    owner,
    relativePaths: [file.relativePath],
    hostId:
      capturedHostId ??
      (file.externalSshTargetId
        ? toSshExecutionHostId(file.externalSshTargetId)
        : owner
          ? toRuntimeExecutionHostId(owner)
          : null)
  }
}

export function getSidebarWatchConsumer(
  state: EditorExternalWatchTargetState,
  worktreeId: string
): WatchConsumer {
  // Why: sidebar watcher must follow the selected worktree's host owner, not the host currently focused in the UI.
  const owner = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  if (owner) {
    return { owner, hostId: toRuntimeExecutionHostId(owner), relativePaths: null }
  }
  const selectedHost = parseExecutionHostId(state.activeWorkspaceExecutionHostId)
  return {
    owner,
    hostId: selectedHost && selectedHost.kind !== 'runtime' ? selectedHost.id : null,
    relativePaths: null
  }
}

export function addWatchConsumer(
  consumersByWorktreeId: Map<string, Map<string, WatchConsumer>>,
  worktreeId: string,
  consumer: WatchConsumer
): void {
  let consumers = consumersByWorktreeId.get(worktreeId)
  if (!consumers) {
    consumers = new Map()
    consumersByWorktreeId.set(worktreeId, consumers)
  }
  const key = `${consumer.owner ?? ''}::${consumer.hostId ?? ''}`
  const existing = consumers.get(key)
  consumers.set(
    key,
    existing
      ? {
          ...existing,
          relativePaths: mergeRelativePaths(existing.relativePaths, consumer.relativePaths)
        }
      : consumer
  )
}
