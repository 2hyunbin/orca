import React from 'react'
import { translate } from '@/i18n/i18n'
import { ProjectGroupNameDialog } from '../../ProjectGroupNameDialog'
import { ProjectGroupDeleteDialog } from '../../ProjectGroupDeleteDialog'
import type { ProjectGroupDialogs } from './use-project-group-dialogs'

export function SidebarWorktreeListDialogs({
  dialogs
}: {
  dialogs: ProjectGroupDialogs
}): React.JSX.Element {
  const { nameDialog, setNameDialog, deleteDialog, setDeleteDialog } = dialogs
  return (
    <>
      <ProjectGroupNameDialog
        open={nameDialog !== null}
        title={
          nameDialog?.type === 'rename'
            ? translate('auto.components.sidebar.WorktreeList.f9dc6cc5d3', 'Rename Project Group')
            : translate('auto.components.sidebar.WorktreeList.13757c053c', 'New Project Group')
        }
        description={
          nameDialog?.type === 'rename'
            ? translate(
                'auto.components.sidebar.WorktreeList.bc1460beb3',
                'Update the group name shown in the sidebar.'
              )
            : translate(
                'auto.components.sidebar.WorktreeList.d880ea0744',
                'Create a group and move this project into it.'
              )
        }
        initialName={
          nameDialog?.type === 'rename'
            ? nameDialog.currentName
            : nameDialog
              ? `${nameDialog.repo.displayName} group`
              : ''
        }
        confirmLabel={nameDialog?.type === 'rename' ? 'Rename' : 'Create'}
        onOpenChange={(open) => {
          if (!open) {
            setNameDialog(null)
          }
        }}
        onSubmit={dialogs.handleSubmitProjectGroupName}
      />
      <ProjectGroupDeleteDialog
        open={deleteDialog !== null}
        groupName={deleteDialog?.groupName ?? ''}
        projectCount={dialogs.deleteProjectCount}
        projectNames={dialogs.deleteProjectNames}
        removeContainedProjects={dialogs.removeContainedProjects}
        onRemoveContainedProjectsChange={(removeContainedProjects) => {
          setDeleteDialog((current) =>
            current ? { ...current, removeContainedProjects } : current
          )
        }}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteDialog(null)
          }
        }}
        onConfirm={dialogs.handleConfirmDeleteProjectGroup}
        unsavedTargets={dialogs.deleteUnsavedTargets}
      />
    </>
  )
}
