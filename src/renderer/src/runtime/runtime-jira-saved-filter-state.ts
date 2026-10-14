import {
  normalizeJiraSavedFilterState,
  type JiraSavedFilterState,
  type JiraSavedFilterMutation
} from '../../../shared/jira-saved-filters'
import {
  JIRA_SAVED_FILTER_RUNTIME_CAPABILITY,
  JIRA_SAVED_FILTER_UPDATE_REQUIRED
} from '../../../shared/jira-saved-filter-capability'
import { assertRuntimeEnvironmentCapability, callRuntimeRpc } from './runtime-rpc-client'
import { getJiraRuntimeTarget, type RuntimeJiraSettings } from './runtime-jira-target'

export async function readJiraSavedFilterState(source: RuntimeJiraSettings): Promise<JiraSavedFilterState> {
  const target = getJiraRuntimeTarget(source)
  if (target.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(target.environmentId, JIRA_SAVED_FILTER_RUNTIME_CAPABILITY,
      JIRA_SAVED_FILTER_UPDATE_REQUIRED, 15_000)
    return normalizeJiraSavedFilterState(await callRuntimeRpc(target, 'ui.getJiraSavedFilters', undefined, { timeoutMs: 15_000 }))
  }
  if (!window.api.ui.getJiraSavedFilters) {throw new Error(JIRA_SAVED_FILTER_UPDATE_REQUIRED)}
  return normalizeJiraSavedFilterState(await window.api.ui.getJiraSavedFilters())
}

export async function mutateJiraSavedFilters(source: RuntimeJiraSettings, mutation: JiraSavedFilterMutation): Promise<JiraSavedFilterState> {
  const target = getJiraRuntimeTarget(source)
  if (target.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(target.environmentId, JIRA_SAVED_FILTER_RUNTIME_CAPABILITY,
      JIRA_SAVED_FILTER_UPDATE_REQUIRED, 15_000)
    return normalizeJiraSavedFilterState(await callRuntimeRpc(target, 'ui.mutateJiraSavedFilters', mutation, { timeoutMs: 15_000 }))
  }
  if (!window.api.ui.mutateJiraSavedFilters) {throw new Error(JIRA_SAVED_FILTER_UPDATE_REQUIRED)}
  return normalizeJiraSavedFilterState(await window.api.ui.mutateJiraSavedFilters(mutation))
}
