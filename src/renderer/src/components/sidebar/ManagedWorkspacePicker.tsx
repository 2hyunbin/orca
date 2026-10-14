import { useMemo } from 'react'
import { FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { getAllWorktreesFromState } from '@/store/selectors'
import { getFolderWorkspaceHostId } from '@/store/folder-workspaces/folder-workspace-catalog'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { translate } from '@/i18n/i18n'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

export function ManagedWorkspacePicker({
  environmentId,
  onOpen
}: {
  environmentId: string
  onOpen: () => void
}): React.JSX.Element | null {
  const worktrees = useAppStore(getAllWorktreesFromState)
  const folders = useAppStore((s) => s.folderWorkspaces)
  const groups = useAppStore((s) => s.projectGroups)
  const hostId = toRuntimeExecutionHostId(environmentId)
  const choices = useMemo(
    () =>
      [
        ...worktrees
          .filter((row) => !row.isArchived && row.hostId === hostId)
          .map((row) => ({
            id: row.id,
            name: row.displayName,
            path: row.path,
            activity: row.lastActivityAt
          })),
        ...folders
          .filter((row) => !row.isArchived && getFolderWorkspaceHostId(row, groups) === hostId)
          .map((row) => ({
            id: folderWorkspaceKey(row.id),
            name: row.name,
            path: row.folderPath,
            activity: row.lastActivityAt
          }))
      ].sort((a, b) => b.activity - a.activity || a.name.localeCompare(b.name)),
    [worktrees, folders, groups, hostId]
  )
  if (!choices.length) {
    return null
  }
  const label = translate('plugins.managedWorkspace.savedWorkspaces', 'Saved workspaces')
  return (
    <section aria-label={label} className="space-y-2">
      <p className="text-sm font-medium">{label}</p>
      <div className="max-h-48 space-y-2 overflow-y-auto scrollbar-sleek">
        {choices.map((choice) => (
          <div key={choice.id} className="min-w-0">
            <Button
              variant="outline"
              onClick={() => {
                const state = useAppStore.getState()
                if (state.modalData.managedWorkspaceEnvironmentId !== environmentId) {
                  return
                }
                if (
                  activateAndRevealWorkspace(choice.id, {
                    executionHostId: hostId,
                    showWorkspaceList: true
                  })
                ) {
                  onOpen()
                }
              }}
            >
              <FolderOpen />
              <span className="max-w-60 truncate">
                {translate('plugins.managedWorkspace.openSaved', 'Open {{name}}', {
                  name: choice.name
                })}
              </span>
            </Button>
            <p className="truncate text-xs text-muted-foreground">{choice.path}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
