// Where the browser-history block lands inside the omnibox entry rows: below
// exact/literal file matches and typed URLs, above fuzzy files and fallbacks.

import { dropUrlEntriesCoveredByHistoryRows } from './open-tab-entry-dedupe'
import {
  isActiveEntryOption,
  type ActiveOption,
  type BrowserHistoryOmniboxRow
} from './tab-create-entry-active-option'
import type { TabEntryOption } from './tab-create-entry-action'

// Scattered path characters are weaker evidence than a matching page.
function isStrongFileOrUrlOption(option: TabEntryOption): boolean {
  const { classification } = option
  const { kind } = classification
  return (
    (kind === 'existing-file' && classification.matchKind !== 'fuzzy') ||
    kind === 'absolute-file' ||
    kind === 'explicit-url' ||
    kind === 'host-url'
  )
}

export function insertHistoryRowsBelowFileMatches(
  entryOptions: readonly TabEntryOption[],
  historyRows: readonly BrowserHistoryOmniboxRow[]
): readonly ActiveOption[] {
  const options = dropUrlEntriesCoveredByHistoryRows(entryOptions, historyRows)
    .filter(isActiveEntryOption)
    .map((option) => ({ kind: 'entry' as const, option }))
  if (historyRows.length === 0) {
    return options
  }
  let insertAt = 0
  for (const [index, option] of options.entries()) {
    if (isStrongFileOrUrlOption(option.option)) {
      insertAt = index + 1
    }
  }
  return [
    ...options.slice(0, insertAt),
    ...historyRows.map((option) => ({ kind: 'history' as const, option })),
    ...options.slice(insertAt)
  ]
}
