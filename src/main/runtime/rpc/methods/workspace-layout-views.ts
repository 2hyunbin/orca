// The `view.*` events (design 2.2): what a view reports about itself, and navigation requests
// addressed to a view. Not on the phone allowlist; in phase 1 only the local window sends them.

import {
  ViewContentFactsParams,
  ViewDraftStateParams,
  ViewNavigateParams,
  ViewPageStateParams,
  ViewScrollbackParams,
  ViewSetStateParams
} from '../../../../shared/rpc-contract/workspace-layout-view-params'
import { defineMethod } from '../core'
import { senderViewId } from './workspace-layout-commands'

export const WORKSPACE_LAYOUT_VIEW_METHODS = [
  defineMethod({
    name: 'view.setState',
    permission: 'workspace',
    params: ViewSetStateParams,
    handler: async ({ record }, ctx) => {
      ctx.runtime.layoutCommands.views.setRecord(senderViewId(ctx), record)
      return { ok: true }
    }
  }),
  defineMethod({
    name: 'view.draftState',
    permission: 'workspace',
    params: ViewDraftStateParams,
    handler: async ({ workspace, tabId, dirty }, { runtime }) => {
      runtime.layoutCommands.views.setDraftState(workspace, tabId, dirty)
      return { ok: true }
    }
  }),
  defineMethod({
    name: 'view.scrollback',
    permission: 'workspace',
    params: ViewScrollbackParams,
    handler: async ({ paneKey, serialized }, { runtime }) => {
      runtime.layoutCommands.views.setScrollback(paneKey, serialized)
      return { ok: true }
    }
  }),
  defineMethod({
    name: 'view.pageState',
    permission: 'workspace',
    params: ViewPageStateParams,
    handler: async ({ workspace, browserTabId, tab, pages }, { runtime }) => {
      runtime.layoutCommands.views.setPageState(workspace, browserTabId, tab, pages)
      return { ok: true }
    }
  }),
  defineMethod({
    name: 'view.contentFacts',
    permission: 'workspace',
    params: ViewContentFactsParams,
    handler: async (facts, ctx) => {
      ctx.runtime.layoutCommands.views.setContentFacts(senderViewId(ctx), facts)
      return { ok: true }
    }
  }),
  defineMethod({
    name: 'view.navigate',
    permission: 'workspace',
    params: ViewNavigateParams,
    handler: async ({ viewId, request }, { runtime }) => {
      runtime.layoutCommands.views.navigate(viewId, request)
      return { ok: true }
    }
  })
]
