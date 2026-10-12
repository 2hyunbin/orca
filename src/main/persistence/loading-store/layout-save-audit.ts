import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

// SPIKE (option B): measures what a versioned single-saver rule would see; changes no behaviour.

type WindowSave = { hostId: string; kind: string; rules: Set<string> }

let currentWindowSave: WindowSave | null = null
const versionByHost = new Map<string, number>()
const versionAtLastWindowSaveByHost = new Map<string, number>()
const mainWritersSinceWindowSaveByHost = new Map<string, string[]>()
const lastRefByHost = new Map<string, unknown>()

function writerLabel(): string {
  const limit = Error.stackTraceLimit
  Error.stackTraceLimit = 40
  const stack = new Error('layout-audit').stack ?? ''
  Error.stackTraceLimit = limit
  // The spike builds main unminified so these are real function names.
  return stack
    .split('\n')
    .slice(1)
    .map((line) => /at (?:async )?([^\s(]+)/.exec(line.trim())?.[1] ?? '?')
    .join('<')
}

export function beginWindowLayoutSave(hostId: string, kind: string): void {
  currentWindowSave = { hostId, kind, rules: new Set() }
}

export function endWindowLayoutSave(): void {
  const save = currentWindowSave
  currentWindowSave = null
  if (!save) {
    return
  }
  const writers = mainWritersSinceWindowSaveByHost.get(save.hostId) ?? []
  const base = versionAtLastWindowSaveByHost.get(save.hostId) ?? 0
  const current = versionByHost.get(save.hostId) ?? 0
  console.log(
    `[layout-audit] window-save host=${save.hostId} kind=${save.kind} base=${base} ` +
      `stale=${writers.length > 0} interveningMainWrites=${writers.length} ` +
      `rules=[${[...save.rules].join(',')}] writers=${JSON.stringify(writers)} now=${current}`
  )
  mainWritersSinceWindowSaveByHost.set(save.hostId, [])
  versionAtLastWindowSaveByHost.set(save.hostId, current)
}

/** Records a rebase rule that changed the payload, attributed to the save in flight. */
export function recordRebaseRule(
  rule: string,
  before: WorkspaceSessionState,
  after: WorkspaceSessionState
): void {
  if (before === after || JSON.stringify(before) === JSON.stringify(after)) {
    return
  }
  if (currentWindowSave) {
    currentWindowSave.rules.add(rule)
    return
  }
  console.log(`[layout-audit] main-rule ${rule} writer=${writerLabel()}`)
}

/** Called on every in-memory session write; bumps each partition whose object changed. */
export function recordLayoutPartitionWrites(
  partitions: ReadonlyMap<string, WorkspaceSessionState | undefined>
): void {
  for (const [hostId, session] of partitions) {
    if (lastRefByHost.get(hostId) === session) {
      continue
    }
    lastRefByHost.set(hostId, session)
    const version = (versionByHost.get(hostId) ?? 0) + 1
    versionByHost.set(hostId, version)
    if (currentWindowSave) {
      continue
    }
    const writer = writerLabel()
    const list = mainWritersSinceWindowSaveByHost.get(hostId) ?? []
    list.push(writer)
    mainWritersSinceWindowSaveByHost.set(hostId, list)
    console.log(`[layout-audit] main-write host=${hostId} v=${version} writer=${writer}`)
  }
}
