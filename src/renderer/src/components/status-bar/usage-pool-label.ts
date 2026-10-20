import { translate } from '@/i18n/i18n'
import { formatRateLimitWindowChipLabel, formatWindowLabel } from '@/lib/window-label-formatter'
import type {
  ProviderRateLimits,
  RateLimitBucket,
  RateLimitWindow
} from '../../../../shared/rate-limit-types'
import { clampUsedPercent } from '../../../../shared/usage-percentage-display'
import { USAGE_URGENT_PERCENT } from './provider-extra-usage-section'

export type PoolLabelParts = {
  group: string
  fullGroup: string
  window: string
}

const WEEKLY_WINDOW_MINUTES = 10_080

function shortenGroup(group: string): string {
  const short = group
    .replace(/\s+models$/i, '')
    .replace(/\s+and\s+/gi, '/')
    .trim()
  return short || group
}

function groupPart(group: string, buckets: readonly RateLimitBucket[]): string {
  const short = shortenGroup(group)
  const groups = new Set(buckets.map((b) => b.group).filter((g): g is string => Boolean(g)))
  groups.add(group)
  const collides = [...groups].some((other) => other !== group && shortenGroup(other) === short)
  return collides ? group : short
}

function windowPart(bucket: RateLimitBucket, now?: number): string {
  // Why used % regardless of display: urgency is about consumption, matching getUsageTone.
  if (clampUsedPercent(bucket.usedPercent) >= USAGE_URGENT_PERCENT && bucket.resetsAt != null) {
    return formatRateLimitWindowChipLabel(bucket, now)
  }
  // Why before the length rule: formatWindowLabel(0) is "0m", and an unmapped agy window has no length.
  if (!(bucket.windowMinutes > 0)) {
    return (bucket.windowName ?? '').replace(/\s*limit remaining$/i, '').trim()
  }
  if (bucket.windowMinutes === WEEKLY_WINDOW_MINUTES) {
    return translate('auto.components.status.bar.StatusBar.5c938d39ac', 'wk')
  }
  return formatWindowLabel(bucket.windowMinutes)
}

/** null when the bucket has no `group`. Collisions are computed over all `buckets`, not just visible ones. */
export function getPoolLabelParts(
  bucket: RateLimitBucket,
  buckets: readonly RateLimitBucket[],
  now?: number
): PoolLabelParts | null {
  // Why: ungrouped pools (Gemini CLI, Cursor) keep their names; Gemini's 60m window must not read "Pro 1h".
  if (!bucket.group) {
    return null
  }
  return {
    group: groupPart(bucket.group, buckets),
    fullGroup: bucket.group,
    window: windowPart(bucket, now)
  }
}

/** `${group} ${window}` (trimmed) when grouped, else `bucket.name`. */
export function formatPoolShortLabel(
  bucket: RateLimitBucket,
  buckets: readonly RateLimitBucket[],
  now?: number
): string {
  const parts = getPoolLabelParts(bucket, buckets, now)
  return parts ? `${parts.group} ${parts.window}`.trim() : bucket.name
}

/** Status-bar label for a headline section: the pool short label when `section.window` is a grouped bucket in `p.buckets`, else `section.label`. */
export function formatStatusBarSectionLabel(
  p: ProviderRateLimits,
  section: { label: string; window: RateLimitWindow },
  now?: number
): string {
  // Why identity: getWindowSections passes the bucket object itself as the section window.
  const bucket = p.buckets?.find((b) => b === section.window)
  return bucket?.group && p.buckets ? formatPoolShortLabel(bucket, p.buckets, now) : section.label
}
