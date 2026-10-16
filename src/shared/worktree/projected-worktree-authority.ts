import { parseExecutionHostId, type ExecutionHostId } from '../execution-host'

export function projectedWorktreeAuthority(row: {
  hostId?: ExecutionHostId
  runtimeOwnerEnvironmentId?: string
}): string | null {
  const host = parseExecutionHostId(row.hostId)
  return (
    row.runtimeOwnerEnvironmentId?.trim() || (host?.kind === 'runtime' ? host.environmentId : null)
  )
}
