import { defineMethod } from '../core'

export const SIDEBAR_INPUT_METHODS = [
  defineMethod({
    name: 'sidebarInputs.activityFacts',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => runtime.getWorkspaceActivityFacts()
  })
]
