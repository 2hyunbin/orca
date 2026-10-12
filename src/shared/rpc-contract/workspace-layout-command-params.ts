// Params of the `layout.*` commands (design 2.1): each command's fields beside its type, plus
// `select`. Unsaved drafts are not params: the runtime holds what views report (`view.draftState`).

import { z } from 'zod'
import type { EditorTabView } from '../editor-tab-view-types'
import { TerminalPaneLayoutNodeSchema } from './session-tabs-schemas-params'
import { TerminalOrphanGroupLayout } from './terminal-orphan-params'

const Id = z.string().min(1).max(512)
const On = z.object({
  workspace: Id,
  /** Also show the result in the sender's view. */
  select: z.boolean().optional()
})
const InitialSize = z.object({
  cols: z.number().int().min(1).max(2000),
  rows: z.number().int().min(1).max(2000)
})
const InitialSurface = z.enum(['restore', 'activation'])

const EDITOR_TAB_VIEW_MODES: ReadonlySet<string> = new Set<EditorTabView['mode']>([
  'edit',
  'diff',
  'markdown-preview',
  'conflict-review',
  'check-details',
  'chat-visual'
])

// The view is the window's own record of what the tab shows; the runtime keeps and publishes it.
const EditorTabViewSchema = z.custom<EditorTabView>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    'mode' in value &&
    typeof value.mode === 'string' &&
    EDITOR_TAB_VIEW_MODES.has(value.mode),
  'Invalid editor tab view'
)

export const LayoutCreateTerminalTabParams = On.extend({
  groupId: Id.optional(),
  afterTabId: Id.optional(),
  index: z.number().int().min(0).optional(),
  title: z.string().max(512).optional(),
  color: z.string().max(64).optional(),
  viewMode: z.enum(['terminal', 'chat']).optional(),
  creation: z
    .object({
      defaultTitle: z.string().max(512).optional(),
      shellOverride: z.string().min(1).max(512).optional(),
      forceHostRuntime: z.boolean().optional(),
      startupCwd: z.string().min(1).max(4096).optional()
    })
    .optional(),
  initial: InitialSurface.optional(),
  initialSize: InitialSize.optional()
})

export const LayoutSplitPaneParams = On.extend({
  tabId: Id,
  leafId: Id,
  direction: z.enum(['vertical', 'horizontal']),
  ratio: z.number().gt(0).lt(1).optional(),
  initialSize: InitialSize.optional(),
  /** The new pane's cwd; the tab's startup cwd otherwise. */
  cwd: z.string().min(1).max(4096).optional()
})

export const LayoutClosePaneParams = On.extend({ tabId: Id, leafId: Id })

export const LayoutCloseTabsParams = On.extend({
  tabIds: z.array(Id).min(1).max(1000),
  force: z.boolean().optional(),
  refusePinned: z.boolean().optional()
})

export const LayoutMoveTabParams = On.extend({
  tabId: Id,
  toGroupId: Id,
  index: z.number().int().min(0)
})

export const LayoutSplitGroupParams = On.extend({
  tabId: Id,
  besideGroupId: Id,
  direction: z.enum(['left', 'right', 'up', 'down'])
})

export const LayoutSetGroupRatiosParams = On.extend({ groupLayout: TerminalOrphanGroupLayout })

export const LayoutSetPaneRatiosParams = On.extend({
  tabId: Id,
  root: TerminalPaneLayoutNodeSchema
})

export const LayoutMovePaneParams = On.extend({
  tabId: Id,
  leafId: Id,
  targetLeafId: Id,
  side: z.enum(['left', 'right', 'top', 'bottom'])
})

export const LayoutEqualizePanesParams = On.extend({ tabId: Id })

export const LayoutMovePaneToNewTabParams = On.extend({
  tabId: Id,
  leafId: Id,
  groupId: Id.optional(),
  index: z.number().int().min(0).optional()
})

const AiVaultTitle = z.object({
  agent: z.enum(['claude', 'codex']),
  sessionId: Id,
  title: z.string().max(512)
})

export const LayoutRenameTabParams = z.union([
  On.extend({
    tabId: Id,
    kind: z.enum(['custom', 'generated']),
    title: z.string().max(512).nullable()
  }),
  On.extend({ tabId: Id, kind: z.literal('aiVault'), title: AiVaultTitle.nullable() })
])

export const LayoutRenamePaneParams = On.extend({
  tabId: Id,
  leafId: Id,
  title: z.string().max(512).nullable()
})

export const LayoutSetTabPropsParams = On.extend({
  tabId: Id,
  color: z.string().max(64).nullable().optional(),
  isPinned: z.boolean().optional(),
  viewMode: z.enum(['terminal', 'chat']).optional()
})

export const LayoutSetChatPaneParams = On.extend({ tabId: Id, leafId: Id.nullable() })

export const LayoutOpenEditorTabParams = On.extend({
  fileId: Id.pipe(z.string().max(4096)),
  contentType: z.enum(['editor', 'diff', 'conflict-review', 'check-details', 'chat-visual']),
  file: z
    .object({
      filePath: z.string().min(1).max(4096),
      relativePath: z.string().max(4096),
      language: z.string().max(128),
      runtimeEnvironmentId: z.string().max(512).nullable().optional(),
      externalSshTargetId: z.string().max(512).optional(),
      readOnly: z.boolean().optional(),
      liveTail: z.boolean().optional()
    })
    .optional(),
  view: EditorTabViewSchema.optional(),
  groupId: Id.optional(),
  preview: z.boolean().optional()
})

export const LayoutPromotePreviewTabParams = On.extend({ tabId: Id })

export const LayoutOpenBrowserTabParams = On.extend({
  profileId: z.string().max(512).nullable().optional(),
  groupId: Id.optional()
})

export const LayoutSetBrowserTabProfileParams = On.extend({
  tabId: Id,
  profileId: Id
})

export const LayoutOpenAgentSessionTabParams = On.extend({
  sessionId: Id,
  agent: z.string().min(1).max(128),
  groupId: Id.optional(),
  initial: InitialSurface.optional()
})

export const LayoutStartPaneParams = On.extend({
  paneKey: Id,
  initialSize: InitialSize.optional()
})

export const LayoutRestartPaneParams = On.extend({
  paneKey: Id,
  initialSize: InitialSize.optional()
})
