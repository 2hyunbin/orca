import type { HostedReviewInfo } from '../../../../shared/hosted-review'

type ReviewCacheEntry<T> = {
  data: T | null
}

export function selectReviewCacheEntry<T, Entry extends ReviewCacheEntry<T>>(
  cache: Readonly<Record<string, Entry>>,
  key: string | null
): Entry | undefined {
  return key ? cache[key] : undefined
}

export function selectReviewCacheData<T>(
  cache: Readonly<Record<string, ReviewCacheEntry<T>>>,
  key: string | null
): T | null {
  return selectReviewCacheEntry(cache, key)?.data ?? null
}

export function selectLatestReviewLookup(
  hostedEntry:
    | (ReviewCacheEntry<Pick<HostedReviewInfo, 'provider' | 'number'>> & {
        lookupRevision?: number
        stale?: boolean
      })
    | undefined,
  prEntry: (ReviewCacheEntry<{ number: number }> & { lookupRevision?: number }) | undefined
) {
  const hostedRevision = hostedEntry?.stale ? undefined : hostedEntry?.lookupRevision
  if (
    prEntry?.lookupRevision !== undefined &&
    prEntry.lookupRevision >= (hostedRevision ?? -Infinity)
  ) {
    return {
      revision: prEntry.lookupRevision,
      provider: prEntry.data ? ('github' as const) : null,
      number: prEntry.data?.number ?? null
    }
  }
  if (!hostedEntry || hostedRevision === undefined) {
    return null
  }
  return {
    revision: hostedRevision,
    provider: hostedEntry.data?.provider ?? null,
    number: hostedEntry.data?.number ?? null
  }
}
