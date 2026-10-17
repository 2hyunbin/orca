import { defineMethod } from '../core'
import { getRegisteredSshState, listRegisteredSshTargets } from '../../../ssh/ssh-target-registry'
import { getWslHostService } from '../../../wsl/wsl-host-service-instance'
import { readDesktopSidebarFacts } from '../../sidebar-inputs/desktop-sidebar-facts'
import { RepoIconDataUrlsParams } from '../../../../shared/sidebar-list/repo-icon-data-urls-contract'

export const SIDEBAR_INPUT_METHODS = [
  defineMethod({
    name: 'sidebarInputs.activityFacts',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => runtime.getWorkspaceActivityFacts()
  }),
  defineMethod({
    name: 'sidebarInputs.repoIcons',
    permission: 'workspace',
    params: RepoIconDataUrlsParams,
    handler: async ({ ids }, { runtime }) => runtime.repoIconDataUrls.read(ids)
  }),
  defineMethod({
    name: 'sidebarInputs.desktopFacts',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) =>
      readDesktopSidebarFacts({
        store: runtime.requireStore(),
        sshTargets: listRegisteredSshTargets(),
        sshStateOf: getRegisteredSshState,
        wslStatuses: getWslHostService()?.getStatuses() ?? []
      })
  }),
  defineMethod({
    name: 'sidebarInputs.pairedServerRows',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => runtime.pairedServerRows.snapshot()
  }),
  defineMethod({
    name: 'sidebarInputs.reviewFacts',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => runtime.getWorkspaceReviewFacts()
  })
]
