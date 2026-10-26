import React from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import type { Row } from '../../../../../../shared/sidebar-list/row-types'
import { getVirtualRowTransform } from '../viewport/virtual-rows'
import { PendingWorktreeRow } from '../../PendingWorktreeRow'
import ImportedWorktreesVisibilityLine from '../../ImportedWorktreesVisibilityLine'
import { useAppStore } from '@/store'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import type { Repo } from '../../../../../../shared/repo-types'
import type { ImportedWorktreeCardActionState } from '../../imported-worktrees-card-actions'

export function canKeepImportedWorktreesHidden(
  row: Extract<Row, { type: 'imported-worktrees-card' }>,
  actionState: ImportedWorktreeCardActionState | undefined
): boolean {
  return !row.managing && actionState?.forceVisible !== true
}

type NoticeRowFrameProps = {
  vItem: VirtualItem
  measureVirtualRowElement: (element: HTMLDivElement | null) => void
  className?: string
  children: React.ReactNode
}

// Share the absolute virtual frame across non-card rows.
function NoticeRowFrame({
  vItem,
  measureVirtualRowElement,
  className = 'absolute left-0 right-0 top-0',
  children
}: NoticeRowFrameProps): React.JSX.Element {
  return (
    <div
      role="presentation"
      data-worktree-virtual-row
      data-worktree-virtual-row-key={String(vItem.key)}
      data-worktree-virtual-row-start={vItem.start}
      data-index={vItem.index}
      ref={measureVirtualRowElement}
      className={className}
      style={{ transform: getVirtualRowTransform(vItem.start) }}
    >
      {children}
    </div>
  )
}

function focusProjectMenu(repo: Repo): void {
  requestAnimationFrame(() => {
    const scope = getRepoHostIdentity(repo)
    Array.from(document.querySelectorAll<HTMLButtonElement>('[data-workspace-project-menu]'))
      .find((button) => button.dataset.workspaceProjectMenu === scope)
      ?.focus({ preventScroll: true })
  })
}

export function renderImportedWorktreesVirtualRow(args: {
  row: Extract<Row, { type: 'imported-worktrees-card' }>
  vItem: VirtualItem
  measureVirtualRowElement: (element: HTMLDivElement | null) => void
  actionState: ImportedWorktreeCardActionState | undefined
  onShow: (repo: Repo, paths: readonly string[]) => Promise<boolean>
  onKeepHidden: (repo: Repo) => Promise<boolean>
}): React.JSX.Element {
  const { row, actionState } = args
  return (
    <NoticeRowFrame
      key={args.vItem.key}
      vItem={args.vItem}
      measureVirtualRowElement={args.measureVirtualRowElement}
    >
      <ImportedWorktreesVisibilityLine
        repoDisplayName={row.repo.displayName}
        hostContextLabel={row.hostContextLabel}
        hostContextHostId={row.hostContextHostId}
        hiddenWorktrees={row.hiddenWorktrees}
        placement={row.placement}
        managing={row.managing}
        pending={actionState?.pending ?? false}
        error={actionState?.error ?? null}
        onShow={(paths) => args.onShow(row.repo, paths)}
        onKeepHidden={
          canKeepImportedWorktreesHidden(row, actionState)
            ? () => args.onKeepHidden(row.repo)
            : undefined
        }
        onFocusRecovery={() => focusProjectMenu(row.repo)}
        onClose={() => {
          const state = useAppStore.getState()
          if (
            state.activeModal === 'worktree-visibility' &&
            state.modalData.inline === true &&
            state.modalData.repoId === row.repo.id &&
            state.modalData.hostId === getRepoExecutionHostId(row.repo)
          ) {
            state.closeModal()
          }
        }}
      />
    </NoticeRowFrame>
  )
}

export function renderNewExternalWorktreesInboxVirtualRow(args: {
  row: Extract<Row, { type: 'new-external-worktrees-inbox' }>
  vItem: VirtualItem
  measureVirtualRowElement: (element: HTMLDivElement | null) => void
  actionState: ImportedWorktreeCardActionState | undefined
  onShow: (repo: Repo, paths: readonly string[]) => Promise<boolean>
  onKeepHidden: (repo: Repo) => Promise<boolean>
}): React.JSX.Element {
  return renderImportedWorktreesVirtualRow({
    ...args,
    row: {
      ...args.row,
      type: 'imported-worktrees-card',
      hiddenWorktrees: args.row.inboxWorktrees,
      placement: 'repo-group'
    }
  })
}

export function renderPendingCreationVirtualRow(args: {
  row: Extract<Row, { type: 'pending-creation' }>
  vItem: VirtualItem
  measureVirtualRowElement: (element: HTMLDivElement | null) => void
}): React.JSX.Element {
  return (
    <NoticeRowFrame
      key={args.vItem.key}
      vItem={args.vItem}
      measureVirtualRowElement={args.measureVirtualRowElement}
      className="absolute left-0 right-0 top-0 px-2 pb-1.5"
    >
      <PendingWorktreeRow
        creationId={args.row.creationId}
        repoName={args.row.repo?.displayName ?? null}
      />
    </NoticeRowFrame>
  )
}
