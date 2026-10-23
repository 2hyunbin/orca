import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import type { RuntimeWorkspaceFileRoute } from '@/lib/runtime-workspace-file-route'
import { useAppStore } from '@/store'
import { selectKnownWorktreeById } from '@/store/selectors'
import { getIndexedRepoMap } from '@/store/worktree-repo-index'
import { openLinkedFileInEditor } from './terminal-file-link-editor-open'
import { reserveDetectedFilePathOpenTurn } from './terminal-file-open-turn'

const OTHER_WORKSPACE_HINT_TOAST_ID = 'terminal-file-other-workspace'
let hintShown = false

export type FileInOtherWorkspace = {
  /** The tab the link opened here. */
  fileId: string
  filePath: string
  owner: RuntimeWorkspaceFileRoute
  runtimeEnvironmentId: string | null | undefined
  position: { line: number | null; column: number | null }
}

/** Opens the file as its owning workspace's own file, with that workspace in front. */
export function openFileInOwningWorkspace(file: FileInOtherWorkspace): void {
  const { owner } = file
  // Why: a later link click supersedes this open's line reveal, as it would any link open.
  const isCurrentOpen = reserveDetectedFilePathOpenTurn()
  activateAndRevealWorkspace(owner.worktreeId, {
    providesInitialSurface: true,
    executionHostId: owner.executionHostId
  })
  openLinkedFileInEditor(
    {
      filePath: file.filePath,
      relativePath: owner.relativePath,
      worktreeId: owner.worktreeId,
      runtimeEnvironmentId: file.runtimeEnvironmentId
    },
    null,
    file.position,
    isCurrentOpen
  )
}

/** A newer link click supersedes the hint, so its action never opens an older link's file. */
export function dismissFileInOtherWorkspaceHint(): void {
  if (hintShown) {
    hintShown = false
    toast.dismiss(OTHER_WORKSPACE_HINT_TOAST_ID)
  }
}

/** The link opened here; this names the workspace that holds the file and offers to go there. */
export function showFileInOtherWorkspaceHint(file: FileInOtherWorkspace): void {
  const state = useAppStore.getState()
  // Why: a reused editable tab is not the read-only view this hint describes.
  if (state.openFiles.find((openFile) => openFile.id === file.fileId)?.readOnly !== true) {
    return
  }
  const worktree = selectKnownWorktreeById(state, file.owner.worktreeId, file.owner.executionHostId)
  const workspaceName = worktree ? resolveWorktreeDisplayName(worktree) : ''
  // Why: worktrees of different projects share names like "main"; the project tells them apart.
  const repoName =
    worktree && 'repoId' in worktree
      ? getIndexedRepoMap(state.repos).get(worktree.repoId)?.displayName
      : undefined
  hintShown = true
  const hidden = (): void => {
    hintShown = false
  }
  toast(
    workspaceName
      ? translate(
          'auto.components.terminal.pane.TerminalLinkActionPopover.fileInOtherWorkspace',
          'This file is in {{value0}}',
          {
            value0:
              repoName && repoName !== workspaceName
                ? `${repoName} · ${workspaceName}`
                : workspaceName
          }
        )
      : translate(
          'auto.components.terminal.pane.TerminalLinkActionPopover.fileInAnotherWorkspace',
          'This file is in another workspace'
        ),
    {
      id: OTHER_WORKSPACE_HINT_TOAST_ID,
      duration: 8000,
      description: translate(
        'auto.components.terminal.pane.TerminalLinkActionPopover.openedHereReadOnly',
        'Opened here as read-only'
      ),
      action: {
        label: translate(
          'auto.components.terminal.pane.TerminalLinkActionPopover.openInOwningWorkspace',
          'Open there'
        ),
        onClick: () => openFileInOwningWorkspace(file)
      },
      onDismiss: hidden,
      onAutoClose: hidden
    }
  )
}
