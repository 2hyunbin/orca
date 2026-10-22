/**
 * What the real round trip may legitimately change, so the comparison catches everything else:
 * schema defaults the host's load fills in, ids it derives, and representation changes the move
 * makes on purpose. Each known gap is a real loss, named here so a fix has to remove it.
 */
import { isRecord } from '../../moving-wsl-projects/wsl-move-canonical-form'

/** Session fields the real pipeline does not carry yet, with why; each still differs today. */
export const WSL_MOVE_ROUND_TRIP_KNOWN_GAPS: Readonly<Record<string, string>> = {
  markdownFrontmatterVisible: 'Dropped by the export (file-keyed by the UNC path); a UI toggle.',
  closedTerminalTabTombstonesByTabId: 'Reopen-closed-tab records are not carried.',
  activeWorktreeIdsOnShutdown: 'Never seeded: focus belongs to whoever looks at the host.',
  terminalSurfaceTombstonesByPaneKey: 'Fences of local PTY incarnations; the host starts its own.'
}

// Values the host's load fills in where the source row left the field out.
const DEFAULTED: Readonly<Record<string, readonly string[]>> = {
  repos: ['gitUsername', 'hookSettings', 'kind'],
  projects: ['kind'],
  // Re-derived on the host from the project the setup resolves to.
  worktreeMeta: ['projectId'],
  // Moved disabled; the ledgered `host-automations` step turns them back on (checked separately).
  automations: ['enabled']
}
const DEFAULTED_SESSION: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  browserTabsByWorktree: { sessionPartition: null, sessionProfileId: null },
  sleepingAgentSessionsByPaneKey: { connectionId: null }
}

function withoutKeys(value: unknown, keys: ReadonlySet<string>): unknown {
  return JSON.parse(JSON.stringify(value ?? null), (key, entry: unknown) =>
    keys.has(key) ? undefined : entry
  )
}

function withoutDefaultValues(
  value: unknown,
  defaults: Readonly<Record<string, unknown>>
): unknown {
  return JSON.parse(JSON.stringify(value ?? null), (key, entry: unknown) =>
    Object.hasOwn(defaults, key) && entry === defaults[key] ? undefined : entry
  )
}

/** Empty per-repo lists are the same as none. */
function withoutEmptyLists(value: unknown): unknown {
  if (!isRecord(value)) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => !(Array.isArray(entry) && entry.length === 0))
  )
}

/**
 * Local-only scrollback travels as a host scrollback snapshot. Returns the destination session
 * with exactly those snapshot refs removed, or null when a parked leaf did not become one.
 */
export function withoutParkedScrollbackRefs(
  sourceSession: unknown,
  destinationSession: unknown
): Record<string, unknown> | null {
  const parked = isRecord(sourceSession) ? sourceSession.localOnlyScrollbackByTabId : undefined
  const next = structuredClone(isRecord(destinationSession) ? destinationSession : {})
  const layouts = next.terminalLayoutsByTabId
  for (const [tabId, leaves] of Object.entries(isRecord(parked) ? parked : {})) {
    const layout = isRecord(layouts) ? layouts[tabId] : undefined
    const refs = isRecord(layout) ? layout.scrollbackRefsByLeafId : undefined
    if (!isRecord(layout) || !isRecord(refs) || !isRecord(leaves)) {
      return null
    }
    for (const leafId of Object.keys(leaves)) {
      if (typeof refs[leafId] !== 'string') {
        return null
      }
      delete refs[leafId]
    }
    if (Object.keys(refs).length === 0) {
      delete layout.scrollbackRefsByLeafId
    }
  }
  return next
}

/** One projection with every allowed difference taken out; the same on both sides. */
export function normalizeWslMoveRoundTripProjection(projection: unknown): unknown {
  if (!isRecord(projection)) {
    return projection
  }
  const next: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(projection)) {
    if (field === 'session') {
      continue
    }
    const defaulted = DEFAULTED[field]
    next[field] =
      field === 'sparsePresetsByRepo'
        ? withoutEmptyLists(value)
        : defaulted
          ? withoutKeys(value, new Set(defaulted))
          : value
  }
  const session = isRecord(projection.session) ? projection.session : {}
  const nextSession: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(session)) {
    if (
      Object.hasOwn(WSL_MOVE_ROUND_TRIP_KNOWN_GAPS, field) ||
      field === 'localOnlyScrollbackByTabId'
    ) {
      continue
    }
    // An empty record is the same as none.
    if (isRecord(value) && Object.keys(value).length === 0) {
      continue
    }
    const defaults = DEFAULTED_SESSION[field]
    nextSession[field] = defaults ? withoutDefaultValues(value, defaults) : value
  }
  next.session = nextSession
  return next
}
