import { GitBranch } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { MemorySnapshot } from '../../../../shared/process-stats-types'
import { getRuntimePathBasename } from '../../../../shared/cross-platform-path'
import type { RuntimeHostResourceSample } from './resource-usage-merge-types'

export function ResourceGitMaintenanceStatus({
  local,
  hosts
}: {
  local: MemorySnapshot['gitMaintenance']
  hosts: readonly RuntimeHostResourceSample[]
}): React.JSX.Element | null {
  const rows = [
    ...(local ?? []).map((activity) => ({
      ...activity,
      hostId: 'local',
      hostLabel: translate('resourceManager.thisComputer', 'This computer')
    })),
    ...hosts.flatMap((host) =>
      (host.gitMaintenance ?? []).map((activity) => ({
        ...activity,
        hostId: host.hostId,
        hostLabel: host.hostLabel
      }))
    )
  ]
  if (rows.length === 0) {
    return null
  }
  return (
    <div role="status" className="shrink-0 border-b border-border px-3 py-2 text-2xs">
      <div className="flex items-center gap-1.5 font-medium text-foreground">
        <GitBranch aria-hidden="true" className="size-3 shrink-0" />
        {translate('resourceManager.gitMaintenanceRunning', 'Git maintenance running')}
      </div>
      {rows.map((row) => (
        <div
          key={`${row.hostId}:${row.repoPath}:${row.phase}`}
          className="mt-1 flex min-w-0 gap-1.5 text-muted-foreground"
        >
          <span className="max-w-1/3 truncate">{row.hostLabel}</span>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate font-mono" title={row.repoPath}>
            {getRuntimePathBasename(row.repoPath) || row.repoPath}
          </span>
          <span className="ml-auto shrink-0">{getPhaseLabel(row.phase)}</span>
        </div>
      ))}
    </div>
  )
}

function getPhaseLabel(
  phase: NonNullable<MemorySnapshot['gitMaintenance']>[number]['phase']
): string {
  switch (phase) {
    case 'objects':
      return translate('resourceManager.gitMaintenanceObjects', 'Compacting objects')
    case 'pack-index':
      return translate('resourceManager.gitMaintenancePackIndex', 'Updating pack index')
    case 'refs':
      return translate('resourceManager.gitMaintenanceRefs', 'Packing refs')
  }
}
