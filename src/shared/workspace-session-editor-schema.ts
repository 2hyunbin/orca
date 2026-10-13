/* Why: the editor slice of the persisted workspace session. Split out of
 * workspace-session-schema.ts to keep that file inside its line budget, the
 * same way the browser slice already is; the schema itself is unchanged. */
import { z } from 'zod'
import { pluginViewerViewportSchema } from './plugins/plugin-viewer-surface'
import { pluginViewerSourceViewSchema } from './plugins/plugin-viewer-source-view'
import { pluginViewerTabViewportsSchema } from './plugins/plugin-viewer-view-state'

export const persistedOpenFileSchema = z.object({
  filePath: z.string(),
  relativePath: z.string(),
  worktreeId: z.string(),
  language: z.string(),
  isPreview: z.boolean().optional(),
  runtimeEnvironmentId: z.string().nullable().optional(),
  externalSshTargetId: z.string().trim().min(1).optional(),
  dirtyDraftContent: z.string().optional(),
  lastKnownDiskSignature: z.string().optional(),
  readOnly: z.boolean().optional(),
  liveTail: z.boolean().optional(),
  fileOpening: pluginViewerSourceViewSchema.optional(),
  pluginViewerUserSelectedFile: z.literal(true).optional(),
  pluginViewer: z
    .strictObject({
      key: z.string().min(1).max(256),
      viewport: pluginViewerViewportSchema.optional(),
      viewportsByTab: pluginViewerTabViewportsSchema.optional(),
      sourceView: pluginViewerSourceViewSchema.optional()
    })
    .optional()
})
