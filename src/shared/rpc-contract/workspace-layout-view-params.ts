// Params of the `view.*` events (design 2.2): what a view reports about itself. None of them
// creates, binds, moves or removes anything (rule 5).

import { z } from 'zod'
import type { BrowserPage } from '../browser-workspace-types'
import type { RuntimeMobileTerminalTheme } from '../runtime-mobile-session-tab-contracts'
import type { BrowserTabLiveState } from '../workspace-layout/workspace-layout-beside'
import {
  readLayoutNavigateRequest,
  type LayoutNavigateRequest
} from '../workspace-layout/workspace-layout-stream-frames'
import {
  isLayoutViewRecord,
  type LayoutViewRecord
} from '../workspace-layout/workspace-layout-views'
import { LayoutViewIdParam } from './workspace-layout-params'

const Id = z.string().min(1).max(512)

const isObject = (value: unknown): boolean => typeof value === 'object' && value !== null

export const ViewSetStateParams = z.object({
  viewId: LayoutViewIdParam,
  record: z.custom<LayoutViewRecord>(isLayoutViewRecord, 'Invalid view record')
})

export const ViewDraftStateParams = z.object({
  workspace: Id,
  tabId: Id.pipe(z.string().max(4096)),
  dirty: z.boolean()
})

export const ViewScrollbackParams = z.object({
  paneKey: Id,
  serialized: z.string()
})

// The page host's own records, carried as reported, as the window's save writes them today.
export const ViewPageStateParams = z.object({
  workspace: Id,
  browserTabId: Id,
  tab: z.custom<BrowserTabLiveState>(isObject, 'Invalid browser tab state'),
  pages: z.array(z.custom<BrowserPage>(isObject, 'Invalid browser page')).max(1000)
})

export const ViewContentFactsParams = z.object({
  viewId: LayoutViewIdParam,
  terminalTheme: z.custom<RuntimeMobileTerminalTheme>(isObject).optional(),
  launchDrafts: z
    .record(z.string(), z.object({ text: z.string(), createdAt: z.number() }))
    .optional()
})

export const ViewNavigateParams = z.object({
  viewId: LayoutViewIdParam,
  request: z
    .unknown()
    .transform(readLayoutNavigateRequest)
    .pipe(
      z.custom<LayoutNavigateRequest>((request) => request !== null, 'Invalid navigate request')
    )
})
