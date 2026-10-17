import { CircleX, FolderTree, List, Pin } from 'lucide-react'
import type React from 'react'
import { translate } from '@/i18n/i18n'
import type { PRGroupKey } from '../../../../../../shared/workspace-view/workspace-pr-groups'
import type {
  SidebarHeaderIcon,
  SidebarListLabels
} from '../../../../../../shared/sidebar-list/row-types'
import {
  ConductorDoneIcon,
  ConductorProgressIcon,
  ConductorReviewIcon
} from '../../workspace-status-icons'
import { getWorkspaceStatusVisualMeta } from '../../workspace-status'

export const PR_GROUP_META: Record<
  PRGroupKey,
  {
    label: string
    icon: React.ComponentType<{ className?: string }>
    tone: string
  }
> = {
  done: {
    get label() {
      return translate('auto.components.sidebar.worktree.list.groups.5076efc3d2', 'Done')
    },
    icon: ConductorDoneIcon,
    tone: 'text-workspace-status-done'
  },
  'in-review': {
    get label() {
      return translate('auto.components.sidebar.worktree.list.groups.6798dc7c94', 'In review')
    },
    icon: ConductorReviewIcon,
    tone: 'text-workspace-status-review'
  },
  'in-progress': {
    get label() {
      return translate('auto.components.sidebar.worktree.list.groups.7c2f009786', 'In progress')
    },
    icon: ConductorProgressIcon,
    tone: 'text-workspace-status-progress'
  },
  closed: {
    get label() {
      return translate('auto.components.sidebar.worktree.list.groups.682ed5d551', 'Closed')
    },
    icon: CircleX,
    tone: 'text-zinc-600 dark:text-zinc-300'
  }
}

const PROJECT_GROUP_META = {
  tone: 'text-foreground',
  icon: FolderTree
} as const

const PINNED_GROUP_META = {
  get label() {
    return translate('auto.components.sidebar.worktree.list.groups.4aeefc5996', 'Pinned')
  },
  tone: 'text-foreground',
  icon: Pin
} as const

const ALL_GROUP_META = {
  get label() {
    return translate('auto.components.sidebar.worktree.list.groups.0ed04075b8', 'All')
  },
  tone: 'text-foreground',
  icon: List
} as const

/** The header labels the shared row builder needs, in the current locale. */
export function getSidebarListLabels(): SidebarListLabels {
  return {
    pinned: PINNED_GROUP_META.label,
    all: ALL_GROUP_META.label,
    prGroups: {
      done: PR_GROUP_META.done.label,
      'in-review': PR_GROUP_META['in-review'].label,
      'in-progress': PR_GROUP_META['in-progress'].label,
      closed: PR_GROUP_META.closed.label
    }
  }
}

type SidebarHeaderVisual = {
  tone: string
  icon: React.ComponentType<{ className?: string }>
}

/** The glyph and tone the window draws for a header's icon key. */
export function getSidebarHeaderVisual(icon: SidebarHeaderIcon): SidebarHeaderVisual {
  switch (icon.kind) {
    case 'pinned':
      return PINNED_GROUP_META
    case 'all':
      return ALL_GROUP_META
    case 'project':
      return PROJECT_GROUP_META
    case 'pr-status':
      return PR_GROUP_META[icon.prGroup]
    case 'workspace-status':
      return getWorkspaceStatusVisualMeta(icon.status)
  }
}
