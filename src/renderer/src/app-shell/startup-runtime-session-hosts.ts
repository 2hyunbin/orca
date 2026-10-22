import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'

/** Saved runtime hosts whose session slices restore at startup; none when the list fails. */
export async function listRuntimeSessionHostIdsForStartup(): Promise<ExecutionHostId[]> {
  try {
    return (await window.api.runtimeEnvironments.list()).map((environment) =>
      toRuntimeExecutionHostId(environment.id)
    )
  } catch (err) {
    console.warn('Failed to list runtime session hosts for startup:', err)
    return []
  }
}
