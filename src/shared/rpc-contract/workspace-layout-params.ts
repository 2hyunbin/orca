import { z } from 'zod'
import type { LayoutViewId } from '../workspace-layout/workspace-layout-views'

/** `desktop` for the local window, `device:<pairedDeviceId>` for a paired client. */
export const LayoutViewIdParam = z.custom<LayoutViewId>(
  (value) =>
    typeof value === 'string' &&
    (value === 'desktop' || (value.startsWith('device:') && value.length > 'device:'.length)),
  'Invalid view id'
)

export const LayoutSubscribeParams = z
  .object({
    /** Workspace keys to receive; every workspace when absent or 'all'. */
    workspaces: z.union([z.literal('all'), z.array(z.string().min(1))]).optional(),
    /** The subscribing view: its record rides on the snapshot and its navigate frames on the stream. */
    viewId: LayoutViewIdParam.optional()
  })
  .nullish()

export const LayoutUnsubscribeParams = z.object({
  subscriptionId: z.string().min(1, 'Missing subscriptionId')
})
