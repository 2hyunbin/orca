import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import {
  CalendarClock,
  Check,
  CircleDot,
  Copy,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Plug,
  SquareTerminal,
  StickyNote
} from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { prStateColor } from '../components/WorktreeMetaGlyphs'
import { hostScreenStyles } from './host-screen-styles'
import { OptionRowList } from './workspace-option-rows'
import { TaskProviderLogo } from '../components/TaskProviderLogo'
import { useClipboardWriter } from '../platform/clipboard'
import type {
  WorkspaceDetailLink,
  WorkspaceDetailPort,
  WorkspaceOrigin
} from '../worktree/workspace-details-model'

const ICON_SIZE = 16
const COPIED_MS = 1500

const PROVIDER_LABELS: Record<WorkspaceDetailLink['provider'], string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  linear: 'Linear',
  jira: 'Jira',
  bitbucket: 'Bitbucket',
  'azure-devops': 'Azure DevOps',
  gitea: 'Gitea'
}
const STATE_LABELS: Record<string, string> = {
  open: 'Open',
  merged: 'Merged',
  closed: 'Closed',
  draft: 'Draft'
}
// The desktop hover card's checks badge wording.
const CHECK_LABELS: Record<string, string> = {
  success: 'Checks: Passing',
  failure: 'Checks: Failing',
  pending: 'Checks: Pending'
}

export type WorkspaceDetailsSectionProps = {
  links: readonly WorkspaceDetailLink[]
  origin: WorkspaceOrigin | null
  notes: string | null
  /** null while the scan is out, or when the host could not say; the section then stays hidden. */
  ports: readonly WorkspaceDetailPort[] | null
  onOpenLink: (url: string) => void
  /** Shown when nothing else is, for a sheet that has no actions to fall back on. */
  emptyText?: string
}

/**
 * The long-press sheet's details, the phone's take on the desktop sidebar card's hover card:
 * linked reviews and tasks (tap to open), who created the workspace, its notes, and live ports.
 * Only sections the workspace has are drawn.
 */
export function WorkspaceDetailsSection(props: WorkspaceDetailsSectionProps) {
  const { links, origin, notes, ports, onOpenLink, emptyText } = props
  const rows: ReactNode[] = [
    ...links.map((item) => <LinkRow key={item.key} item={item} onOpen={onOpenLink} />),
    origin ? <OriginRow key="origin" origin={origin} /> : null,
    notes ? (
      <DetailRow key="notes" icon={<StickyNote size={ICON_SIZE} color={colors.textSecondary} />}>
        <Text style={styles.notes} numberOfLines={8} selectable>
          {notes}
        </Text>
      </DetailRow>
    ) : null
  ].filter(Boolean)
  const hasPorts = ports !== null && ports.length > 0

  if (rows.length === 0 && !hasPorts) {
    return emptyText ? <Text style={styles.empty}>{emptyText}</Text> : null
  }
  return (
    <View testID="workspace-details">
      {rows.length > 0 && <Card>{rows}</Card>}
      {hasPorts && (
        <>
          <Text style={hostScreenStyles.filterSectionLabel}>
            Live ports <Text style={styles.sectionCount}>{ports.length}</Text>
          </Text>
          <Card>
            {ports.map((port) => (
              <PortRow key={port.id} port={port} />
            ))}
          </Card>
        </>
      )}
    </View>
  )
}

function Card({ children }: { children: ReactNode[] }) {
  return (
    <View style={hostScreenStyles.filterGroup}>
      <OptionRowList>{children}</OptionRowList>
    </View>
  )
}

function DetailRow(props: {
  icon: ReactNode
  children: ReactNode
  trailing?: ReactNode
  onPress?: () => void
  accessibilityLabel?: string
}) {
  const body = (
    <>
      <View style={styles.icon}>{props.icon}</View>
      <View style={styles.text}>{props.children}</View>
      {props.trailing}
    </>
  )
  if (!props.onPress) {
    return <View style={styles.row}>{body}</View>
  }
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={props.onPress}
      accessibilityRole="link"
      accessibilityLabel={props.accessibilityLabel}
    >
      {body}
    </Pressable>
  )
}

function ReviewIcon({ item }: { item: WorkspaceDetailLink }) {
  const color = prStateColor(item.state ?? '')
  if (
    item.state === 'merged' ||
    (item.type === 'mr' && item.state !== 'closed' && item.state !== 'draft')
  ) {
    return <GitMerge size={ICON_SIZE} color={color} />
  }
  if (item.state === 'closed') {
    return <GitPullRequestClosed size={ICON_SIZE} color={color} />
  }
  if (item.state === 'draft') {
    return <GitPullRequestDraft size={ICON_SIZE} color={color} />
  }
  return <GitPullRequest size={ICON_SIZE} color={color} />
}

function LinkIcon({ item }: { item: WorkspaceDetailLink }) {
  if (item.type !== 'issue') {
    return <ReviewIcon item={item} />
  }
  if (item.provider === 'linear' || item.provider === 'jira') {
    return (
      <TaskProviderLogo provider={item.provider} size={ICON_SIZE} color={colors.textSecondary} />
    )
  }
  return <CircleDot size={ICON_SIZE} color={colors.textSecondary} />
}

function linkMeta(item: WorkspaceDetailLink): string {
  const reference = item.title ? item.label : null
  if (item.type === 'issue') {
    return [reference, PROVIDER_LABELS[item.provider]].filter(Boolean).join(' · ')
  }
  // As the desktop's tone rule: checks only speak for a review that is still open.
  const checks = item.state === 'open' && item.checks ? CHECK_LABELS[item.checks] : null
  return [reference, item.state ? STATE_LABELS[item.state] : null, checks]
    .filter(Boolean)
    .join(' · ')
}

function LinkRow({ item, onOpen }: { item: WorkspaceDetailLink; onOpen: (url: string) => void }) {
  const url = item.url
  const meta = linkMeta(item)
  return (
    <DetailRow
      icon={<LinkIcon item={item} />}
      onPress={url ? () => onOpen(url) : undefined}
      accessibilityLabel={`Open ${item.label}${item.title ? `, ${item.title}` : ''}`}
      trailing={url ? <ExternalLink size={14} color={colors.textMuted} /> : undefined}
    >
      <Text style={styles.title} numberOfLines={2}>
        {item.title ?? item.label}
      </Text>
      {meta ? (
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
      ) : null}
    </DetailRow>
  )
}

function OriginRow({ origin }: { origin: WorkspaceOrigin }) {
  if (origin.kind === 'automation') {
    return (
      <DetailRow icon={<CalendarClock size={ICON_SIZE} color={colors.textSecondary} />}>
        <Text style={styles.title} numberOfLines={2}>
          {origin.name ?? 'Created by automation'}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {['Automation', origin.runTitle].filter(Boolean).join(' · ')}
        </Text>
      </DetailRow>
    )
  }
  return (
    <DetailRow icon={<SquareTerminal size={ICON_SIZE} color={colors.textSecondary} />}>
      <Text style={styles.title} numberOfLines={2}>
        {origin.fromAgent ? 'Created by an agent via ' : 'Created via '}
        <Text style={styles.code}>orca worktree create</Text>
      </Text>
      <Text style={styles.meta} numberOfLines={1}>
        {['Orca CLI', origin.startupAgent ? `Started with ${origin.startupAgent}` : null]
          .filter(Boolean)
          .join(' · ')}
      </Text>
    </DetailRow>
  )
}

function PortRow({ port }: { port: WorkspaceDetailPort }) {
  const clipboard = useClipboardWriter()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (timer.current) {
        clearTimeout(timer.current)
      }
    }
  }, [])
  const copy = () => {
    void clipboard
      .writeText(port.address)
      .then(() => {
        // The sheet may have closed while the clipboard answered.
        if (!mounted.current) {
          return
        }
        setCopied(true)
        if (timer.current) {
          clearTimeout(timer.current)
        }
        timer.current = setTimeout(() => setCopied(false), COPIED_MS)
      })
      .catch(() => {
        if (mounted.current) {
          setCopied(false)
        }
      })
  }
  return (
    <DetailRow
      icon={<Plug size={ICON_SIZE} color={colors.textSecondary} />}
      trailing={
        <Pressable
          style={({ pressed }) => [styles.iconButton, pressed && styles.rowPressed]}
          onPress={copy}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={copied ? `Copied ${port.address}` : `Copy ${port.address}`}
        >
          {copied ? (
            <Check size={15} color={colors.textPrimary} />
          ) : (
            <Copy size={15} color={colors.textSecondary} />
          )}
        </Pressable>
      }
    >
      <Text style={[styles.title, styles.code]} numberOfLines={1}>
        {port.address}
      </Text>
      {port.processName ? (
        <Text style={styles.meta} numberOfLines={1}>
          {port.processName}
        </Text>
      ) : null}
    </DetailRow>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  icon: {
    width: ICON_SIZE,
    alignItems: 'center',
    alignSelf: 'flex-start',
    // Centers the icon on the first line of a 14/19 title.
    paddingTop: 2
  },
  text: {
    flex: 1,
    minWidth: 0
  },
  title: {
    fontSize: typography.bodySize,
    lineHeight: 19,
    fontWeight: '500',
    color: colors.textPrimary
  },
  code: {
    fontFamily: typography.monoFamily,
    fontSize: 13
  },
  meta: {
    marginTop: 2,
    fontSize: typography.metaSize,
    color: colors.textMuted
  },
  notes: {
    fontSize: typography.bodySize,
    lineHeight: 19,
    color: colors.textPrimary
  },
  iconButton: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -spacing.xs
  },
  sectionCount: {
    fontWeight: '400'
  },
  empty: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.md
  }
})
