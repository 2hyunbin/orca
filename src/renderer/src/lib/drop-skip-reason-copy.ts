import { translate } from '@/i18n/i18n'
import { compactIpcErrorMessage } from '@/lib/ipc-error'
import type { ImportSkipReason } from '../../../shared/filesystem-import-result-types'

const SKIP_REASON_COPY: Record<ImportSkipReason, { key: string; fallback: string }> = {
  missing: {
    key: 'auto.lib.dropSkipReason.missing',
    fallback: 'No longer at its original path.'
  },
  symlink: {
    key: 'auto.lib.dropSkipReason.symlink',
    fallback: 'Symbolic links cannot be attached.'
  },
  'permission-denied': {
    key: 'auto.lib.dropSkipReason.permissionDenied',
    fallback: 'Permission denied.'
  },
  unsupported: {
    key: 'auto.lib.dropSkipReason.unsupported',
    fallback: 'Unsupported file type.'
  }
}

export function describeDropSkipReason(reason: string): string | undefined {
  if (!isImportSkipReason(reason)) {
    return undefined
  }
  const copy = SKIP_REASON_COPY[reason]
  return translate(copy.key, copy.fallback)
}

function isImportSkipReason(reason: string): reason is ImportSkipReason {
  return Object.hasOwn(SKIP_REASON_COPY, reason)
}

function sharedReason(items: readonly { reason?: string }[]): string | undefined {
  const first = items[0]?.reason
  return first && items.every((item) => item.reason === first) ? first : undefined
}

export function describeSharedDropSkipReason(
  items: readonly { reason: string }[]
): string | undefined {
  const reason = sharedReason(items)
  return reason ? describeDropSkipReason(reason) : undefined
}

/** Toast detail when every rejected item shares one reason; mixed reasons stay generic. */
export function describeSharedDropFailureReason(
  items: readonly { status?: 'skipped' | 'failed'; reason?: string }[]
): string | undefined {
  const reason = sharedReason(items)
  if (!reason) {
    return undefined
  }
  // Why: skip reasons are codes with their own copy; only failures carry the host's prose.
  const skipCopy = describeDropSkipReason(reason)
  return (
    skipCopy ??
    (items.some((item) => item.status === 'skipped') ? undefined : compactIpcErrorMessage(reason))
  )
}
