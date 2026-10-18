import {
  SIDEBAR_INPUTS_PAGE_MAX_BYTES,
  type SidebarInputsChangedEvent,
  type SidebarInputsDomainChange,
  type SidebarInputsReadParams,
  type SidebarInputsReadResult
} from './sidebar-inputs-feed-contract'

/** The inputs a reader has installed whole: every domain's entities at one revision. */
export type InstalledSidebarInputs = {
  generation: string
  revision: number
  schemaVersion: number
  semanticsVersion: number
  domains: ReadonlyMap<string, ReadonlyMap<string, unknown>>
}

type StagedBatch = Pick<SidebarInputsReadResult, 'generation' | 'revision' | 'kind' | 'from'> & {
  pages: readonly SidebarInputsReadResult['domains'][]
}

/**
 * A phone's feed reader for one host connection. One read is in flight at a time; a change
 * noticed meanwhile, during paging included, costs one more read after it installs.
 */
export type SidebarInputsFeedState = {
  installed: InstalledSidebarInputs | null
  /** The pages of the batch being read, installed only once its last page lands. */
  staged: StagedBatch | null
  /** The read in flight; a reply to any other request is stale and dropped. */
  inFlight: number | null
  /** Something may have changed since the read in flight began. */
  again: boolean
  lastRequestId: number
}

export type SidebarInputsFeedRequest = { id: number; params: SidebarInputsReadParams }

export type SidebarInputsFeedStep = {
  state: SidebarInputsFeedState
  /** The read to send now, if any. */
  request: SidebarInputsFeedRequest | null
}

export const INITIAL_SIDEBAR_INPUTS_FEED_STATE: SidebarInputsFeedState = {
  installed: null,
  staged: null,
  inFlight: null,
  again: false,
  lastRequestId: 0
}

function send(state: SidebarInputsFeedState, params: Omit<SidebarInputsReadParams, 'maxBytes'>) {
  const id = state.lastRequestId + 1
  return {
    state: { ...state, inFlight: id, lastRequestId: id },
    request: { id, params: { ...params, maxBytes: SIDEBAR_INPUTS_PAGE_MAX_BYTES } }
  }
}

/** A fresh read from what is installed, which covers every change noticed so far. */
function readFromInstalled(state: SidebarInputsFeedState): SidebarInputsFeedStep {
  const { installed } = state
  return send(
    { ...state, staged: null, again: false },
    installed ? { generation: installed.generation, cursor: installed.revision } : {}
  )
}

/** On every stream ready and return to the foreground. */
export function refreshSidebarInputs(state: SidebarInputsFeedState): SidebarInputsFeedStep {
  return state.inFlight === null
    ? readFromInstalled(state)
    : { state: { ...state, again: true }, request: null }
}

/** A change notice; one this reader already has or is fetching is a duplicate or arrived late. */
export function sidebarInputsChanged(
  state: SidebarInputsFeedState,
  event: Pick<SidebarInputsChangedEvent, 'generation' | 'revision'>
): SidebarInputsFeedStep {
  const newest = state.staged ?? state.installed
  if (newest?.generation === event.generation && event.revision <= newest.revision) {
    return { state, request: null }
  }
  return refreshSidebarInputs(state)
}

/** The read failed or the connection dropped; the next ready, foreground or notice reads again. */
export function sidebarInputsReadFailed(
  state: SidebarInputsFeedState,
  requestId?: number
): SidebarInputsFeedState {
  if (requestId !== undefined && requestId !== state.inFlight) {
    return state
  }
  return { ...state, inFlight: null, staged: null, again: false }
}

export function sidebarInputsReplied(
  state: SidebarInputsFeedState,
  requestId: number,
  reply: SidebarInputsReadResult
): SidebarInputsFeedStep {
  if (requestId !== state.inFlight) {
    return { state, request: null }
  }
  const settled = { ...state, inFlight: null }
  if (reply.kind === 'reset') {
    return readFromInstalled(settled)
  }
  const { staged, installed } = state
  const continues = staged
    ? staged.generation === reply.generation &&
      staged.revision === reply.revision &&
      staged.kind === reply.kind &&
      staged.from === reply.from
    : reply.kind === 'snapshot' ||
      (installed?.generation === reply.generation && reply.from === installed.revision)
  if (!continues) {
    // Not the batch this reader asked for: only a whole snapshot is safe now.
    return send({ ...settled, staged: null, again: false }, {})
  }
  const batch: StagedBatch = {
    generation: reply.generation,
    revision: reply.revision,
    kind: reply.kind,
    from: reply.from,
    pages: [...(staged?.pages ?? []), reply.domains]
  }
  if (reply.next !== null) {
    return send({ ...settled, staged: batch }, { pageToken: reply.next })
  }
  const done = { ...settled, staged: null }
  if (installed?.generation === batch.generation && batch.revision < installed.revision) {
    return done.again ? readFromInstalled(done) : { state: done, request: null }
  }
  const next = installBatch(installed, batch, reply)
  if (!next) {
    return send({ ...done, again: false }, {})
  }
  const installedState = { ...done, installed: next }
  return installedState.again
    ? readFromInstalled(installedState)
    : { state: installedState, request: null }
}

/** Applies a whole batch as one step; null when an entity's joined parts are not JSON. */
function installBatch(
  installed: InstalledSidebarInputs | null,
  batch: StagedBatch,
  last: Pick<SidebarInputsReadResult, 'schemaVersion' | 'semanticsVersion'>
): InstalledSidebarInputs | null {
  const domains = new Map(batch.kind === 'snapshot' ? [] : (installed?.domains ?? []))
  const touched = new Map<string, Map<string, unknown>>()
  const parts = new Map<string, Map<string, string>>()
  const entitiesOf = (name: string): Map<string, unknown> => {
    let entities = touched.get(name)
    if (!entities) {
      entities = new Map(domains.get(name) ?? [])
      touched.set(name, entities)
    }
    return entities
  }
  for (const page of batch.pages) {
    for (const [name, change] of Object.entries(page)) {
      applyDomainChange(entitiesOf(name), change, parts, name)
    }
  }
  for (const [name, texts] of parts) {
    for (const [key, text] of texts) {
      try {
        entitiesOf(name).set(key, JSON.parse(text))
      } catch {
        return null
      }
    }
  }
  for (const [name, entities] of touched) {
    domains.set(name, entities)
  }
  return {
    generation: batch.generation,
    revision: batch.revision,
    schemaVersion: last.schemaVersion,
    semanticsVersion: last.semanticsVersion,
    domains
  }
}

function applyDomainChange(
  entities: Map<string, unknown>,
  change: SidebarInputsDomainChange,
  parts: Map<string, Map<string, string>>,
  name: string
): void {
  for (const [key, value] of Object.entries(change.upserts)) {
    entities.set(key, value)
  }
  for (const key of change.removals) {
    entities.delete(key)
  }
  for (const [key, text] of Object.entries(change.parts)) {
    const texts = parts.get(name) ?? new Map<string, string>()
    parts.set(name, texts)
    texts.set(key, (texts.get(key) ?? '') + text)
  }
}
