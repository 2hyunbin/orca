import { translate } from '@/i18n/i18n'
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

// Ordered: a "too large" refusal can also read as a write failure.
const FAILURE_CATEGORIES: readonly { matches: RegExp; key: string; fallback: string }[] = [
  {
    matches: /file_too_large|\btoo large\b|\bis larger than\b|remote import limit/i,
    key: 'auto.lib.dropFailureReason.tooLarge',
    fallback: 'Too large to upload to this host.'
  },
  {
    matches: /\bENOSPC\b|no space left|disk quota|\bEDQUOT\b/i,
    key: 'auto.lib.dropFailureReason.noSpace',
    fallback: 'The host is out of disk space.'
  },
  {
    matches: /\bEACCES\b|\bEPERM\b|\bEROFS\b|permission[ _]denied|read-only file system/i,
    key: 'auto.lib.dropSkipReason.permissionDenied',
    fallback: 'Permission denied.'
  },
  {
    matches: /changed during upload|changed while/i,
    key: 'auto.lib.dropFailureReason.changed',
    fallback: 'The file changed while it was uploading. Try again.'
  },
  {
    matches: /\bENOENT\b|no such file/i,
    key: 'auto.lib.dropSkipReason.missing',
    fallback: 'No longer at its original path.'
  },
  {
    matches:
      /\bE(?:CONNRESET|CONNREFUSED|TIMEDOUT|PIPE|HOSTUNREACH)\b|timed out|disconnect|not connected|unreachable/i,
    key: 'auto.lib.dropFailureReason.hostUnreachable',
    fallback: 'Lost the connection to the host. Try again once it reconnects.'
  }
]

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
  if (skipCopy || items.some((item) => item.status === 'skipped')) {
    return skipCopy
  }
  // Why: host prose can quote absolute paths and toasts are often on shared screens; keep it in logs.
  console.warn('[drop] upload failed:', reason)
  const category = FAILURE_CATEGORIES.find((entry) => entry.matches.test(reason))
  if (category) {
    return translate(category.key, category.fallback)
  }
  return items.length === 1
    ? translate('auto.lib.dropFailureReason.unknownOne', "Couldn't upload this file.")
    : translate('auto.lib.dropFailureReason.unknownMany', "Couldn't upload these files.")
}
