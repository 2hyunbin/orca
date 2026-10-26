import React, { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import NoticeHostGlyph from './NoticeHostGlyph'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  isWorkspaceDiscoveryTelemetryEnabled,
  trackWorkspaceDiscoveryAction,
  trackWorkspaceDiscoveryShown
} from './workspace-discovery-telemetry'

export type ImportedWorktreesVisibilityPlacement = 'repo-group' | 'pinned-fallback' | 'standalone'
export type ImportedWorktreeVisibilityPreview = {
  displayName: string
  path: string
}

export type ImportedWorktreesVisibilityLineProps = {
  repoDisplayName: string
  hostContextLabel?: string
  hostContextHostId?: ExecutionHostId
  hiddenWorktrees: readonly ImportedWorktreeVisibilityPreview[]
  placement: ImportedWorktreesVisibilityPlacement
  pending: boolean
  error: string | null
  onReview: () => void
  onKeepHidden?: () => Promise<boolean>
  onFocusRecovery?: () => void
  className?: string
}

export default function ImportedWorktreesVisibilityLine({
  repoDisplayName,
  hostContextLabel,
  hostContextHostId,
  hiddenWorktrees,
  placement,
  pending,
  error,
  onReview,
  onKeepHidden,
  onFocusRecovery,
  className
}: ImportedWorktreesVisibilityLineProps): React.JSX.Element | null {
  const [submitting, setSubmitting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const telemetryEnabled = useAppStore((state) =>
    isWorkspaceDiscoveryTelemetryEnabled(state.settings?.telemetry)
  )
  const busy = pending || submitting
  const count = hiddenWorktrees.length
  const scope = hostContextLabel ? `${repoDisplayName} on ${hostContextLabel}` : repoDisplayName

  useEffect(() => {
    if (telemetryEnabled && count > 0) {
      trackWorkspaceDiscoveryShown('suggestion', count)
    }
  }, [count, telemetryEnabled])

  async function dismiss(): Promise<void> {
    if (!onKeepHidden || busy) {
      return
    }
    setSubmitting(true)
    setLocalError(null)
    try {
      if (await onKeepHidden()) {
        if (telemetryEnabled) {
          trackWorkspaceDiscoveryAction('suggestion', 'dismissed', count)
        }
        onFocusRecovery?.()
      } else {
        setLocalError(
          translate('workspaceDiscovery.dismissError', 'Could not hide suggestions. Try again.')
        )
      }
    } catch {
      setLocalError(
        translate('workspaceDiscovery.dismissError', 'Could not hide suggestions. Try again.')
      )
    } finally {
      setSubmitting(false)
    }
  }

  if (count === 0) {
    return null
  }

  const countLabel =
    count === 1
      ? translate('workspaceDiscovery.oneFound', '1 other workspace found')
      : translate('workspaceDiscovery.found', '{{count}} other workspaces found', { count })

  return (
    <section
      aria-busy={busy}
      className={cn('mx-1 my-0.5 ml-3 min-w-0 text-worktree-sidebar-foreground', className)}
    >
      <div className="flex min-h-8 min-w-0 items-center gap-1 rounded-md px-1.5 text-2xs text-muted-foreground hover:bg-worktree-sidebar-accent">
        <button
          type="button"
          disabled={busy}
          aria-label={translate(
            'workspaceDiscovery.reviewScope',
            'Review hidden workspaces for {{scope}}',
            { scope }
          )}
          onClick={() => {
            if (telemetryEnabled) {
              trackWorkspaceDiscoveryAction('suggestion', 'reviewed', count)
            }
            onReview()
          }}
          className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-worktree-sidebar-ring disabled:opacity-60"
        >
          <span className="min-w-0 flex-1">
            {countLabel}
            {placement === 'repo-group' ? '' : ` · ${scope}`}
          </span>
          {hostContextLabel && placement === 'repo-group' ? (
            <span className="inline-flex min-w-0 items-center gap-1">
              {hostContextHostId ? (
                <NoticeHostGlyph
                  hostId={hostContextHostId}
                  hostLabel={hostContextLabel}
                  keyboardFocusable={false}
                />
              ) : null}
              <span>{hostContextLabel}</span>
            </span>
          ) : null}
          <span className="shrink-0 underline underline-offset-2">
            {translate('workspaceDiscovery.review', 'Review')}
          </span>
        </button>
        {onKeepHidden ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={busy}
                aria-label={translate(
                  'workspaceDiscovery.dismissScope',
                  'Hide workspace suggestions for {{scope}}',
                  { scope }
                )}
                onClick={() => void dismiss()}
                className="shrink-0"
              >
                <X className="size-3" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {translate('workspaceDiscovery.dismiss', 'Hide suggestions for this project.')}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {error || localError ? (
        <p className="px-1.5 py-1 text-xs text-destructive" role="alert">
          {error || localError}
        </p>
      ) : null}
    </section>
  )
}
