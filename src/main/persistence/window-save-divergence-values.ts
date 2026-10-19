// The save-divergence log's before (main's) and after (the save's) values of each changed field,
// bounded per line and stripped of content: ids, numbers and flags as they are, any other text
// only as its length, since titles, labels, paths and records can hold what a user typed or an
// agent wrote.

/** Keys whose text is an id or a fixed name, read only inside the layout's own records. */
const ID_KEYS = new Set([
  'id',
  'entityId',
  'groupId',
  'leafId',
  'chatLeafId',
  'ptyId',
  'incarnationId',
  'tabOrder',
  'pageIds',
  'sessionProfileId',
  'type',
  'kind',
  'direction',
  'viewMode',
  'agentSessionAgent',
  'launchAgent',
  'color'
])
/**
 * Records and fields that embed other subsystems' data (an agent's resume record carries its prompt,
 * launch env and transcript path; editor views carry git snapshots): only their size is logged.
 */
const OPAQUE_RECORDS = new Set(['file', 'editor view'])
const OPAQUE_FIELDS = new Set(['sleeping', 'value'])
const MAX_ID_LENGTH = 80
const MAX_ITEMS = 8
const MAX_DEPTH = 6
/** Values one report line may carry in all, counted per array, object and scalar. */
const LINE_BUDGET = 120

/** One changed field of one record (`<kind> <id>`), as main holds it and as the save writes it. */
export type FieldChange = { record: string; field: string; before: unknown; after: unknown }

type Budget = { left: number }

function sizeOf(value: object): string {
  return Array.isArray(value) ? `<${value.length} items>` : `<${Object.keys(value).length} keys>`
}

function compact(
  value: unknown,
  key: string | undefined,
  budget: Budget,
  depth: number,
  opaque: boolean
): unknown {
  if (budget.left <= 0) {
    return '…'
  }
  budget.left--
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    return !opaque && key && ID_KEYS.has(key) && value.length <= MAX_ID_LENGTH
      ? value
      : `<text ${value.length}>`
  }
  if (typeof value !== 'object') {
    return `<${typeof value}>`
  }
  if (opaque || depth >= MAX_DEPTH) {
    return sizeOf(value)
  }
  if (Array.isArray(value)) {
    const shown = value
      .slice(0, MAX_ITEMS)
      .map((item) => compact(item, key, budget, depth + 1, false))
    return value.length > MAX_ITEMS ? [...shown, `+${value.length - MAX_ITEMS} more`] : shown
  }
  const entries = Object.entries(value).filter(([, item]) => item !== undefined)
  const shown = Object.fromEntries(
    entries
      .slice(0, MAX_ITEMS)
      .map(([name, item]) => [name, compact(item, name, budget, depth + 1, false)])
  )
  return entries.length > MAX_ITEMS
    ? { ...shown, '+': `${entries.length - MAX_ITEMS} more keys` }
    : shown
}

/** `changes` (with the kind of record each names) compacted for one report line. */
export function compactFieldChanges(
  changes: readonly (FieldChange & { kind: string })[]
): FieldChange[] {
  const budget = { left: LINE_BUDGET }
  return changes.map(({ kind, record, field, before, after }) => {
    const opaque = OPAQUE_RECORDS.has(kind) || OPAQUE_FIELDS.has(field)
    return {
      record,
      field,
      before: compact(before, field, budget, 0, opaque),
      after: compact(after, field, budget, 0, opaque)
    }
  })
}
