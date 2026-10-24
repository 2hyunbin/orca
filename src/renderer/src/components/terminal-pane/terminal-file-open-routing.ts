import { getWorkspaceFilePreviewPlan, openFileInBrowserTab } from '@/lib/file-preview'
import { downloadAndOpenRemoteTerminalFile } from './terminal-remote-file-download-open'
import { isPathInsideWorktree, toWorktreeRelativePath } from '@/lib/terminal-links'
import type { RuntimeWorkspaceFileRoute } from '@/lib/runtime-workspace-file-route'
import { canClientOsOpenWorkspaceFile } from '@/lib/workspace-file-host-routing'
import { isMissingRuntimePathError } from '@/runtime/runtime-file-metadata-client'
import { useAppStore } from '@/store'
import { activateAndRevealWorkspace, activateAndRevealWorktree } from '@/lib/worktree-activation'
import { resolveKnownWorktreeRootPathLink } from './terminal-worktree-path-link'
import {
  getTerminalFileContext,
  mapTerminalFilePath,
  terminalLinkWslDistro,
  type TerminalFileContext
} from './terminal-file-path-mapping'
import {
  LOCAL_EXECUTION_HOST_ID,
  getConnectionExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import { captureEditorOpenLinkIntent } from '@/store/slices/editor/tabs/editor-open-target-group'
import { reserveDetectedFilePathOpenTurn } from './terminal-file-open-turn'
import { openHtmlFileInBrowser } from './terminal-html-file-browser-open'
import { showOpenInGroupRefusedToast } from './terminal-file-open-in-group-toast'
import {
  dismissFileInOtherWorkspaceHint,
  showFileInOtherWorkspaceHint
} from './terminal-file-other-workspace-hint'
import {
  otherWorkspaceViewFields,
  siblingWorkspaceLink
} from './terminal-file-other-workspace-owner'
import { resolveTerminalLinkFileOwner } from './terminal-file-link-owner-resolution'
import { isExplicitEditorScopeKept, openLinkedFileInEditor } from './terminal-file-link-editor-open'

export {
  getTerminalFileContext,
  mapTerminalFilePath,
  terminalLinkWslDistro,
  terminalPathWslDistro,
  type TerminalFileContext
} from './terminal-file-path-mapping'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import {
  httpLinkDirectClickDestination,
  type HttpLinkDestination
} from '@/lib/http-link-destinations'
import { isHtmlFilePath, localHtmlFileDestinations } from './local-html-file-destinations'

export type FileOpenFailure = {
  /** `missing` is a verified absence; `unverifiable` means the host could not answer (dropped SSH, timeout, denied path). */
  verdict: 'missing' | 'unverifiable'
  error: unknown
}

type TerminalFileOpenDeps = {
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId?: string | null
  wslDistro?: string | null
  /** Shift+modifier: the OS default app, or the other link-routing browser for a local HTML file. */
  openWithSystemDefault?: boolean
  /** Where a local HTML file opens, chosen from its popover; otherwise link routing decides. */
  browserDestination?: HttpLinkDestination
  /** The paired-server terminal that printed the link; lets its host grant a file outside workspaces. */
  terminalHandle?: string | null
  /** Reports a path that could not be verified before opening; skipped once a later open supersedes it. */
  onOpenFailure?: (failure: FileOpenFailure) => void
  /** The tab that owns the link; editor opens place themselves relative to its group. */
  sourceTabId?: string | null
  /** "Open in this group": pins the source tab's group at activation, or refuses. */
  openInSourceGroup?: boolean
}

export function shouldOpenTerminalFileWithSystemDefault(fileContext: TerminalFileContext): boolean {
  // Why: an unresolved owner has no connectionId either, which would otherwise read as local.
  return fileContext.sourceHostResolved && canClientOsOpenWorkspaceFile(fileContext)
}

export function openDetectedFilePath(
  filePath: string,
  line: number | null,
  column: number | null,
  deps: TerminalFileOpenDeps
): void {
  const { openWithSystemDefault = false, runtimeEnvironmentId } = deps
  let { worktreeId, worktreePath } = deps
  let mappedFilePath = mapTerminalFilePath(
    filePath,
    worktreePath,
    terminalLinkWslDistro(deps.wslDistro, runtimeEnvironmentId)
  )
  const isCurrentOpen = reserveDetectedFilePathOpenTurn()
  dismissFileInOtherWorkspaceHint()
  // Why: capture at activation; focus may move while the host resolves the path.
  const linkIntent = captureEditorOpenLinkIntent(
    useAppStore.getState(),
    deps.worktreeId,
    deps.sourceTabId,
    { explicitSourceGroup: deps.openInSourceGroup === true }
  )
  const explicitGroupRequest = deps.openInSourceGroup === true
  // Why: an explicit group request never substitutes a browser, system app, or download.
  const refuseExplicitNonEditorRoute = (): boolean => {
    if (!explicitGroupRequest) {
      return false
    }
    if (isCurrentOpen()) {
      showOpenInGroupRefusedToast(mappedFilePath)
    }
    return true
  }

  void (async () => {
    const sourceContext = getTerminalFileContext(worktreeId, worktreePath, runtimeEnvironmentId)
    const sourceRuntimeOwnerId = runtimeTargetEnvironmentId(sourceContext.target)
    if (!sourceContext.sourceHostResolved) {
      // Why: with no owner the host is unknown — refuse rather than touch this machine's files.
      deps.onOpenFailure?.({
        verdict: 'unverifiable',
        error: new Error('The terminal workspace host could not be determined')
      })
      return
    }
    if (!openWithSystemDefault) {
      const worktreeRootLink = resolveKnownWorktreeRootPathLink(
        mappedFilePath,
        useAppStore.getState(),
        sourceContext
      )
      if (worktreeRootLink) {
        if (refuseExplicitNonEditorRoute()) {
          return
        }
        // Root workspace switching avoids local auth/stat for SSH/runtime paths while coalescing provider/fallback clicks.
        await Promise.resolve()
        if (!isCurrentOpen()) {
          return
        }
        activateAndRevealWorktree(worktreeRootLink.id, {
          executionHostId: worktreeRootLink.executionHostId
        })
        return
      }
    }

    let owner
    try {
      owner = await resolveTerminalLinkFileOwner({
        fileContext: sourceContext,
        worktreeId,
        worktreePath,
        filePath: mappedFilePath,
        terminalHandle: deps.terminalHandle
      })
    } catch (error) {
      if (isCurrentOpen() && deps.onOpenFailure) {
        // Why: loss of contact with the host is not evidence the file is gone.
        deps.onOpenFailure({
          verdict: isMissingRuntimePathError(error) ? 'missing' : 'unverifiable',
          error
        })
      }
      return
    }

    if (!isCurrentOpen()) {
      return
    }
    const { fileContext, stat: statResult, hostWorkspaceFile, hostGrantId, clientLocal } = owner
    let otherWorkspaceOwner: RuntimeWorkspaceFileRoute | null = null
    ;({ worktreeId, worktreePath, filePath: mappedFilePath } = owner)

    const canOpenWithSystemDefault = shouldOpenTerminalFileWithSystemDefault(fileContext)
    // Remote hints promise Orca before resolution; explicit group requests fall through for HTML refusal.
    const pageDestination =
      canOpenWithSystemDefault &&
      !clientLocal &&
      hostGrantId === null &&
      !explicitGroupRequest &&
      isHtmlFilePath(mappedFilePath)
        ? (deps.browserDestination ??
          httpLinkDirectClickDestination(localHtmlFileDestinations(), openWithSystemDefault))
        : null
    const opensWithSystemDefault = pageDestination
      ? pageDestination === 'system'
      : openWithSystemDefault
    if (opensWithSystemDefault && canOpenWithSystemDefault) {
      // Shift+Cmd/Ctrl honors OS file associations like URL links.
      const openedWithSystemDefault = await window.api.shell.openFilePath(
        mappedFilePath,
        LOCAL_EXECUTION_HOST_ID
      )
      if (openedWithSystemDefault || statResult.isDirectory) {
        return
      }
    }

    if (statResult.isDirectory) {
      if (refuseExplicitNonEditorRoute()) {
        return
      }
      if (canOpenWithSystemDefault) {
        await window.api.shell.openFilePath(mappedFilePath, LOCAL_EXECUTION_HOST_ID)
      }
      return
    }

    // Why: a granted file is readable only through its grant, so it opens in Orca, never as a download.
    if (openWithSystemDefault && !canOpenWithSystemDefault && hostGrantId === null) {
      // Match the popover’s download-and-open promise; the OS cannot launch a remote path.
      await downloadAndOpenRemoteTerminalFile(fileContext, mappedFilePath)
      return
    }

    // Local HTML opens in Orca’s browser, including fallback when the system browser fails.
    if (isHtmlFilePath(mappedFilePath) && hostGrantId === null) {
      if (canOpenWithSystemDefault) {
        // Why: Orca's browser has no group placement in v1.
        if (refuseExplicitNonEditorRoute()) {
          return
        }
        openHtmlFileInBrowser(mappedFilePath, worktreeId, clientLocal)
        return
      }
      // Render remote HTML through doc preview; unsupported plans fall back to source.
      const plan = getWorkspaceFilePreviewPlan(useAppStore.getState(), worktreeId, mappedFilePath)
      if (plan.status === 'doc-preview') {
        if (refuseExplicitNonEditorRoute()) {
          return
        }
        activateAndRevealWorktree(worktreeId, { providesInitialSurface: true })
        openFileInBrowserTab({ filePath: mappedFilePath, worktreeId })
        return
      }
    }

    const runtimeOwnerId = runtimeTargetEnvironmentId(fileContext.target) ?? sourceRuntimeOwnerId
    const targetExecutionHostId =
      hostWorkspaceFile?.executionHostId ??
      (runtimeOwnerId
        ? toRuntimeExecutionHostId(runtimeOwnerId)
        : getConnectionExecutionHostId(fileContext.connectionId))
    let relativePath = mappedFilePath
    if (worktreePath && isPathInsideWorktree(mappedFilePath, worktreePath)) {
      const maybeRelative = toWorktreeRelativePath(mappedFilePath, worktreePath)
      // Keep external paths absolute so project-file checks do not reject them now or after restore.
      if (maybeRelative !== null && maybeRelative.length > 0 && !statResult.escapesWorktree) {
        relativePath = maybeRelative
      }
    } else if (hostGrantId === null && !clientLocal && !hostWorkspaceFile) {
      const sibling = siblingWorkspaceLink(targetExecutionHostId, mappedFilePath, worktreeId)
      otherWorkspaceOwner = sibling.view
      if (sibling.openInOwner) {
        ;({ worktreeId, relativePath } = sibling.openInOwner)
      }
    }

    if (
      explicitGroupRequest &&
      !isExplicitEditorScopeKept(linkIntent, worktreeId, targetExecutionHostId, clientLocal)
    ) {
      // Why: refuse before activating the destination or touching editor state.
      refuseExplicitNonEditorRoute()
      return
    }

    if (worktreeId) {
      // Folder-workspace keys and worktree IDs shared across hosts require dispatch by workspace shape and resolved host.
      activateAndRevealWorkspace(worktreeId, {
        providesInitialSurface: true,
        executionHostId: targetExecutionHostId
      })
    }

    const opened = openLinkedFileInEditor(
      {
        filePath: mappedFilePath,
        relativePath,
        worktreeId: worktreeId || '',
        runtimeEnvironmentId: clientLocal ? null : runtimeEnvironmentId,
        // Editable tabs must match their workspace owner; Open there uses the owning workspace’s authority.
        ...(clientLocal ? { readOnly: true } : otherWorkspaceViewFields(otherWorkspaceOwner)),
        // Why: the grant is the only authority to read a host file outside its workspaces.
        ...(hostGrantId !== null ? { readOnly: true, terminalArtifactGrantId: hostGrantId } : {}),
        // Preserve SSH ownership: absolute remote paths otherwise look client-local on reload/restore.
        ...(relativePath === filePath &&
        fileContext.target.kind === 'local' &&
        fileContext.connectionId
          ? { externalSshTargetId: fileContext.connectionId }
          : {})
      },
      linkIntent,
      { line, column },
      isCurrentOpen
    )
    if (!opened) {
      refuseExplicitNonEditorRoute()
    } else if (otherWorkspaceOwner && isCurrentOpen()) {
      showFileInOtherWorkspaceHint({
        fileId: opened.fileId,
        filePath: mappedFilePath,
        owner: otherWorkspaceOwner,
        runtimeEnvironmentId: runtimeOwnerId,
        position: { line, column }
      })
    }
  })()
}
