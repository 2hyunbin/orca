import { translate } from '@/i18n/i18n'
import { compactIpcErrorMessage } from '@/lib/ipc-error'
import { basename } from '@/lib/path'
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
  if (skipCopy || items.some((item) => item.status === 'skipped')) {
    return skipCopy
  }
  return describeFailureProse(compactIpcErrorMessage(reason))
}

// Absolute POSIX, drive-letter or UNC paths: whole when quoted (they may hold spaces), else to whitespace.
const QUOTED_ABSOLUTE_PATH = /(['"`])((?:[A-Za-z]:[\\/]|\\\\|\/)[^'"`]*)\1/g
const BARE_ABSOLUTE_PATH = /(?<=^|[\s(])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s'"`)]*/g

// Why: host errors quote absolute paths and toasts are often on shared screens; name only the file.
function describeFailureProse(prose: string | undefined): string | undefined {
  if (!prose) {
    return undefined
  }
  const shortened = prose
    .replace(QUOTED_ABSOLUTE_PATH, (_match, quote: string, path: string) => {
      return `${quote}${basename(path)}${quote}`
    })
    .replace(BARE_ABSOLUTE_PATH, (path) => basename(path))
  const pathOnly =
    prose.replace(QUOTED_ABSOLUTE_PATH, '').replace(BARE_ABSOLUTE_PATH, '').trim() === ''
  return pathOnly ? undefined : shortened
}
