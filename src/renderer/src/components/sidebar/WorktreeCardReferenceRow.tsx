import type { MouseEvent, ReactNode } from 'react'
import { CircleDot, GitMerge, GitPullRequest } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { ReviewChecksIndicator, reviewStateLabel } from './WorktreeCardMetadataStatusBadges'
import { getReviewLabel, ReviewIcon } from './worktree-review-helpers'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'

export function WorktreeCardReferenceRow({
  review,
  kind,
  title,
  label,
  provider,
  source,
  url,
  onOpen,
  onManage,
  actions
}: {
  review: WorktreeCardPrDisplay | null
  kind: 'pr' | 'mr' | 'issue'
  title: string
  label: string
  provider: string
  source?: string | null
  url?: string
  onOpen: (url: string, event: MouseEvent) => void
  onManage?: (event: MouseEvent) => void
  actions?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <div className="mt-0.5 flex w-3.5 shrink-0 flex-col items-center gap-1.5">
        {review ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                aria-label={reviewStateLabel(review.state, getReviewLabel(review))}
                className="inline-flex shrink-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ReviewIcon review={review} className="size-3.5" showChecks={false} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {reviewStateLabel(review.state, getReviewLabel(review))}
            </TooltipContent>
          </Tooltip>
        ) : kind === 'mr' ? (
          <GitMerge className="size-3.5 shrink-0 text-muted-foreground" />
        ) : kind === 'pr' ? (
          <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <CircleDot className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        {review?.status ? <ReviewChecksIndicator status={review.status} /> : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start gap-1">
          <div className="min-w-0 flex-1">
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="line-clamp-2 rounded-sm text-xs font-medium leading-snug underline decoration-muted-foreground/50 underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={translate('workspace.links.openItem', 'Open {{label}}', {
                  label
                })}
                onClick={(event) => {
                  event.stopPropagation()
                  onOpen(url, event)
                }}
                onAuxClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              >
                {title}
              </a>
            ) : (
              <button
                type="button"
                className="line-clamp-2 rounded-sm text-left text-xs font-medium leading-snug outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                disabled={!onManage}
                aria-label={translate('workspace.links.openItem', 'Open {{label}}', {
                  label
                })}
                onClick={onManage}
                onKeyDown={(event) => event.stopPropagation()}
              >
                {title}
              </button>
            )}
          </div>
          {actions}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
          <span className="truncate">
            {label} · {provider}
            {source ? ` · ${source}` : ''}
          </span>
        </div>
      </div>
    </div>
  )
}
