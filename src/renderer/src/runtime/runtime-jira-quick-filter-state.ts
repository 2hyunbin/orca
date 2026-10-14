import {
  JIRA_STATUS_FILTER_RUNTIME_CAPABILITY,
  JIRA_STATUS_FILTER_UPDATE_REQUIRED,
  normalizeJiraQuickFilterState,
  type JiraQuickFilterState
} from '../../../shared/jira-quick-filters'
import { assertRuntimeEnvironmentCapability, callRuntimeRpc } from './runtime-rpc-client'
import { getJiraRuntimeTarget, type RuntimeJiraSettings } from './runtime-jira-target'

export async function readJiraQuickFilterState(
  source: RuntimeJiraSettings
): Promise<JiraQuickFilterState> {
  const target = getJiraRuntimeTarget(source)
  if (target.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      JIRA_STATUS_FILTER_RUNTIME_CAPABILITY,
      JIRA_STATUS_FILTER_UPDATE_REQUIRED,
      15_000
    )
    return normalizeJiraQuickFilterState(
      await callRuntimeRpc(target, 'ui.getJiraQuickFilters', undefined, { timeoutMs: 15_000 })
    )
  }
  if (!window.api.ui.getJiraQuickFilters) {
    throw new Error(JIRA_STATUS_FILTER_UPDATE_REQUIRED)
  }
  return normalizeJiraQuickFilterState(await window.api.ui.getJiraQuickFilters())
}

export async function writeJiraQuickFilterState(
  source: RuntimeJiraSettings,
  state: JiraQuickFilterState
): Promise<JiraQuickFilterState> {
  const target = getJiraRuntimeTarget(source)
  if (target.kind === 'environment') {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      JIRA_STATUS_FILTER_RUNTIME_CAPABILITY,
      JIRA_STATUS_FILTER_UPDATE_REQUIRED,
      15_000
    )
    return normalizeJiraQuickFilterState(
      await callRuntimeRpc(target, 'ui.setJiraQuickFilters', state, { timeoutMs: 15_000 })
    )
  }
  if (!window.api.ui.setJiraQuickFilters) {
    throw new Error(JIRA_STATUS_FILTER_UPDATE_REQUIRED)
  }
  return normalizeJiraQuickFilterState(await window.api.ui.setJiraQuickFilters(state))
}
