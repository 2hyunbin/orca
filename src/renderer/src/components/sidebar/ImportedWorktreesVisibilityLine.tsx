import React, { useEffect, useId, useRef, useState } from 'react'
import { ChevronRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import NoticeHostGlyph from './NoticeHostGlyph'
import WorkspaceDiscoveryWorktreeList from './WorkspaceDiscoveryWorktreeList'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export type ImportedWorktreesVisibilityPlacement = 'repo-group' | 'pinned-fallback'
export type ImportedWorktreeVisibilityPreview = {
  id?: string
  displayName: string
  path: string
  branch?: string
}

export type ImportedWorktreesVisibilityLineProps = {
  repoDisplayName: string
  /** Disambiguates checkouts when the project appears on multiple hosts. */
  hostContextLabel?: string
  hostContextHostId?: ExecutionHostId
  hiddenWorktrees: readonly ImportedWorktreeVisibilityPreview[]
  placement: ImportedWorktreesVisibilityPlacement
  pending: boolean
  error: string | null
  managing?: boolean
  onShow?: (paths: readonly string[]) => Promise<boolean>
  onKeepHidden?: () => Promise<boolean>
  onClose?: () => void
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
  managing = false,
  onShow,
  onKeepHidden,
  onClose,
  onFocusRecovery,
  className
}: ImportedWorktreesVisibilityLineProps): React.JSX.Element | null {
  const [reviewExpanded, setExpanded] = useState(false)
  const expanded = managing || reviewExpanded
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [query, setQuery] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const busy = pending || submitting
  const count = hiddenWorktrees.length
  const paths = hiddenWorktrees.filter((worktree) => selected.has(worktree.path)).map((w) => w.path)
  const scope = hostContextLabel ? `${repoDisplayName} on ${hostContextLabel}` : repoDisplayName

  useEffect(() => {
    if (managing) {
      toggleRef.current?.focus({ preventScroll: true })
    }
  }, [managing])

  const closeReview = (): void => {
    setExpanded(false)
    if (managing) {
      onClose?.()
      onFocusRecovery?.()
    } else {
      toggleRef.current?.focus({ preventScroll: true })
    }
  }

  const addSelected = async (): Promise<void> => {
    if (busy || paths.length === 0 || !onShow) {
      return
    }
    setSubmitting(true)
    setLocalError(null)
    try {
      if (await onShow(paths)) {
        setSelected(new Set())
        setQuery('')
        closeReview()
        requestAnimationFrame(() => {
          if (toggleRef.current?.isConnected && count > paths.length && !managing) {
            toggleRef.current.focus({ preventScroll: true })
          } else {
            onFocusRecovery?.()
          }
        })
      } else {
        setLocalError(translate('workspaceDiscovery.addError', 'Could not add workspaces. Try again.'))
      }
    } catch {
      setLocalError(
        translate('workspaceDiscovery.addError', 'Could not add workspaces. Try again.')
      )
    } finally {
      setSubmitting(false)
    }
  }

  const dismiss = async (): Promise<void> => {
    if (busy || !onKeepHidden) {
      return
    }
    setSubmitting(true)
    setLocalError(null)
    try {
      if (await onKeepHidden()) {
        onFocusRecovery?.()
      } else {
        setLocalError(translate('workspaceDiscovery.dismissError', 'Could not hide suggestions. Try again.'))
      }
    } catch {
      setLocalError(
        translate('workspaceDiscovery.dismissError', 'Could not hide suggestions. Try again.')
      )
    } finally {
      setSubmitting(false)
    }
  }

  if (count === 0 && !managing) {
    return null
  }

  const countLabel = managing
    ? translate('workspaceDiscovery.hiddenCount', '{{count}} hidden workspaces', { count })
    : count === 1
      ? translate('workspaceDiscovery.oneFound', '1 other workspace found')
      : translate('workspaceDiscovery.found', '{{count}} other workspaces found', { count })

  return (
    <section
      aria-busy={busy}
      className={cn('mx-1 my-0.5 ml-3 min-w-0 text-worktree-sidebar-foreground', className)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && expanded && !busy) {
          event.stopPropagation()
          closeReview()
        }
      }}
    >
      <div className="flex min-h-8 min-w-0 items-center gap-1 rounded-md px-1.5 text-2xs text-muted-foreground hover:bg-worktree-sidebar-accent">
        <button
          ref={toggleRef}
          type="button"
          disabled={busy}
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-label={translate(
            'workspaceDiscovery.reviewScope',
            'Review hidden workspaces for {{scope}}',
            { scope }
          )}
          onClick={() => (expanded ? closeReview() : setExpanded(true))}
          className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-worktree-sidebar-ring disabled:opacity-60"
        >
          <ChevronRight
            className={cn('size-3 shrink-0', expanded && 'rotate-90')}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1">
            {countLabel}
            {placement === 'pinned-fallback' ? ` · ${scope}` : ''}
          </span>
          {hostContextLabel && placement !== 'pinned-fallback' ? (
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
          {!expanded ? (
            <span className="shrink-0 underline underline-offset-2">
              {translate('workspaceDiscovery.review', 'Review')}
            </span>
          ) : null}
        </button>
        {onKeepHidden && !managing ? (
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
            <TooltipContent side="bottom" className="max-w-60">
              <p>{translate('workspaceDiscovery.dismiss', 'Hide suggestions for this project.')}</p>
              <p>
                {translate(
                  'workspaceDiscovery.recovery',
                  'Find these later in the project menu → Manage workspaces.'
                )}
              </p>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {expanded ? (
        <div
          id={panelId}
          className="ml-4 min-w-0 border-l border-worktree-sidebar-border pb-2 pl-2"
        >
          <div className="sticky top-0 z-10 grid gap-2 border-b border-worktree-sidebar-border bg-worktree-sidebar px-1.5 py-2">
            <p className="text-xs leading-5 text-muted-foreground">
              {translate(
                'workspaceDiscovery.description',
                'These working copies already exist. Select any you want to add to the sidebar.'
              )}
            </p>
            {count > 0 ? (
              <Button
                type="button"
                size="xs"
                disabled={busy || paths.length === 0 || !onShow}
                onClick={() => void addSelected()}
                className="justify-self-start"
              >
                {busy
                  ? translate('workspaceDiscovery.adding', 'Adding…')
                  : paths.length > 0
                    ? translate('workspaceDiscovery.addCount', 'Add {{count}} to sidebar', {
                        count: paths.length
                      })
                    : translate('workspaceDiscovery.add', 'Add to sidebar')}
              </Button>
            ) : null}
            {error || localError ? <p className="text-xs text-destructive" role="alert">{error || localError}</p> : null}
            {count >= 20 || query ? (
              <Input
                type="search"
                value={query}
                disabled={busy}
                onChange={(event) => setQuery(event.target.value)}
                aria-label={translate('workspaceDiscovery.search', 'Find a workspace')}
                placeholder={translate('workspaceDiscovery.searchPlaceholder', 'Find a workspace…')}
                className="h-8"
              />
            ) : null}
          </div>
          <WorkspaceDiscoveryWorktreeList
            worktrees={hiddenWorktrees}
            selected={selected}
            query={query}
            pending={busy}
            onChange={setSelected}
          />
        </div>
      ) : null}
      {!expanded && (error || localError) ? (
        <p className="px-1.5 py-1 text-xs text-destructive" role="alert">
          {error || localError}
        </p>
      ) : null}
    </section>
  )
}
