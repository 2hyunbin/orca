import type { OpenFile } from '../types/open-file'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import { resolveEditorModelOwner } from '@/components/editor/editor-model-owner'
import { isLocalWindowsDesktopClient } from '@/lib/desktop-window-chrome'
import { resolveContinuedRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { parseWslUncPath } from '../../../../../../shared/wsl-paths'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathSeparators
} from '../../../../../../shared/cross-platform-path'

/** The physical file an edit tab shows. Renderer-local; the workspace is never part of it. */
export type EditorBufferIdentity = {
  /** Environment, host, pairing root and path key: equal keys are one file. */
  key: string
  environmentId: string | null
}

/**
 * Separators and the drive letter are normalized; case is kept, because case sensitivity can
 * differ per directory and a folded key would merge distinct files. Why not
 * `normalizeRuntimePathForComparison`: it lowercases whole Windows paths.
 */
export function editorBufferPathKey(filePath: string, foldWslAliases: boolean): string {
  const wsl = foldWslAliases ? parseWslUncPath(filePath) : null
  if (wsl) {
    // WSL distro names are case-insensitive; the Linux path under them is not.
    return `//wsl/${wsl.distro.toLowerCase()}${wsl.linuxPath}`
  }
  if (!isWindowsAbsolutePathLike(filePath)) {
    // A POSIX backslash is part of the file name.
    return filePath
  }
  const slashed = normalizeRuntimePathSeparators(filePath)
  return /^[A-Za-z]:/.test(slashed) ? `${slashed[0].toLowerCase()}${slashed.slice(1)}` : slashed
}

/** Null for tabs that never share: non-edit views and owners not resolved yet. */
export function editorBufferIdentityOf(
  file: OpenFile,
  state: WorktreeOperationRouteState
): EditorBufferIdentity | null {
  if (file.mode !== 'edit') {
    return null
  }
  const { environmentId, hostId } = resolveEditorModelOwner(file, state)
  if (!hostId) {
    return null
  }
  // A same-host re-pair resolves to the revision it continues; an unproven one stays apart.
  const revisionRoot = environmentId
    ? (resolveContinuedRuntimeEnvironmentRevision(
        environmentId,
        file.operationProvenance?.generation.runtimePairingRevision
      ) ?? null)
    : null
  // `wsl$` and `wsl.localhost` name one distro only on Windows; elsewhere they are plain folders.
  const foldWslAliases = hostId === 'local' && !environmentId && isLocalWindowsDesktopClient()
  return {
    key: JSON.stringify([
      environmentId,
      hostId,
      revisionRoot,
      editorBufferPathKey(file.filePath, foldWslAliases)
    ]),
    environmentId
  }
}

/** True when the identity's environment now names another machine. */
export function isEditorBufferIdentityRetired(
  identity: EditorBufferIdentity,
  retiredEnvironmentIds: readonly string[]
): boolean {
  return identity.environmentId !== null && retiredEnvironmentIds.includes(identity.environmentId)
}

/**
 * A record id no identity key can equal. Records on a retired environment move here and are never
 * merged into the replacement machine's records, even with an identical path and baseline.
 */
export function detachedEditorBufferId(viewId: string): string {
  return `detached:${viewId}`
}
