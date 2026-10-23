import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  AgentSessionModelOption,
  AgentSessionOptionChoice
} from '../../../shared/agent-session-wire'
import {
  agentModelCatalogEntry,
  type AgentModelCatalogEntry,
  type AgentModelCatalogListing
} from './agent-model-catalog-entry'
import { isStructuredAgentId } from '../../../shared/agent-session-provider-handle-encoding'

// 3: Codex models carry `serviceTiers`; an older file would offer Fast with no tier to send.
const SCHEMA_VERSION = 3
const SAVE_COALESCE_MS = 500

export type AgentModelCatalogPersistence = {
  load: () => Promise<AgentModelCatalogEntry[]>
  /** Fire-and-forget, coalesced; a failed write never surfaces to a caller. */
  save: (entries: () => Iterable<AgentModelCatalogEntry>) => void
  /** Writes a coalesced save now; the delay timer is unref'd, so quit must not rely on it. */
  flush: () => Promise<void>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a non-null `typeof === 'object'` value is indexable by string key.
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function parseChoice(value: unknown): AgentSessionOptionChoice | null {
  const row = asRecord(value)
  const choice = text(row?.value)
  const label = text(row?.label)
  if (!choice || !label) {
    return null
  }
  const description = text(row?.description)
  return { value: choice, label, ...(description ? { description } : {}) }
}

function parseModel(value: unknown): AgentSessionModelOption | null {
  const row = asRecord(value)
  const id = text(row?.id)
  const label = text(row?.label)
  if (!row || !id || !label || !Array.isArray(row.efforts)) {
    return null
  }
  const efforts = row.efforts.map(parseChoice)
  if (efforts.some((effort) => effort === null)) {
    return null
  }
  const serviceTiers = Array.isArray(row.serviceTiers)
    ? row.serviceTiers
        .map(parseChoice)
        .filter((tier): tier is AgentSessionOptionChoice => tier !== null)
    : undefined
  const description = text(row.description)
  const defaultEffort = text(row.defaultEffort)
  const resolvedModel = text(row.resolvedModel)
  return {
    id,
    label,
    ...(resolvedModel ? { resolvedModel } : {}),
    ...(row.effortsKnown === false ? { effortsKnown: false as const } : {}),
    ...(description ? { description } : {}),
    isDefault: row.isDefault === true,
    ...(defaultEffort ? { defaultEffort } : {}),
    efforts: efforts.filter((effort): effort is AgentSessionOptionChoice => effort !== null),
    ...(typeof row.supportsFastMode === 'boolean'
      ? { supportsFastMode: row.supportsFastMode }
      : {}),
    ...(typeof row.supportsAutoMode === 'boolean'
      ? { supportsAutoMode: row.supportsAutoMode }
      : {}),
    ...(serviceTiers ? { serviceTiers } : {})
  }
}

function parseListing(value: unknown): AgentModelCatalogListing | null {
  const row = asRecord(value)
  if (
    !row ||
    (row.origin !== 'live-session' && row.origin !== 'probe') ||
    typeof row.at !== 'number' ||
    !Array.isArray(row.models) ||
    row.models.length === 0
  ) {
    return null
  }
  const models = row.models.map(parseModel)
  if (models.some((model) => model === null)) {
    return null
  }
  const support = asRecord(row.fastModeSupport)
  const supported = support?.supported
  const supportReason = text(support?.reason)
  return {
    models: models.filter((model): model is AgentSessionModelOption => model !== null),
    ...(typeof supported === 'boolean'
      ? {
          fastModeSupport: {
            supported,
            ...(supportReason ? { reason: supportReason } : {})
          }
        }
      : {}),
    origin: row.origin,
    at: row.at,
    ...(row.complete === true ? { complete: true } : {})
  }
}

/** Checked reconstruction rather than trust: a field a future schema drops or
 *  reshapes loads as "no entry", never as a corrupt catalog. */
function parseEntry(value: unknown): AgentModelCatalogEntry | null {
  const row = asRecord(value)
  if (!row || !isStructuredAgentId(row.agent) || typeof row.fingerprint !== 'string') {
    return null
  }
  if (row.agent === 'claude' || row.agent === 'codex') {
    const display = parseListing(row.discovered) ?? parseListing(row.live)
    return agentModelCatalogEntry(row.agent, row.fingerprint, display, null, null)
  }
  const configured = asRecord(row.configured)
  const configuredModelId = text(configured?.modelId)
  const configuredEffort = text(configured?.effort)
  const sameModelIds = Array.isArray(configured?.sameModelIds)
    ? configured.sameModelIds.filter((id): id is string => typeof id === 'string')
    : []
  return agentModelCatalogEntry(
    row.agent,
    row.fingerprint,
    parseListing(row.discovered),
    parseListing(row.live),
    configuredModelId && typeof configured?.at === 'number'
      ? {
          modelId: configuredModelId,
          ...(sameModelIds.length > 0 ? { sameModelIds } : {}),
          ...(configuredEffort ? { effort: configuredEffort } : {}),
          at: configured.at
        }
      : null
  )
}

/** Only the two listings and the configured default are written; the merged view is derived again on load. */
function persistedEntry(entry: AgentModelCatalogEntry): unknown {
  return {
    agent: entry.agent,
    fingerprint: entry.fingerprint,
    discovered: entry.discovered,
    live: entry.live,
    ...(entry.configured ? { configured: entry.configured } : {})
  }
}

/** One JSON file of last-good entries. Success-only by construction: failures
 *  are never handed to `save`, and a malformed file loads as empty. */
export function createAgentModelCatalogFilePersistence(
  directory: string
): AgentModelCatalogPersistence {
  const filePath = join(directory, 'agent-model-catalog.json')
  let entries: () => Iterable<AgentModelCatalogEntry> = () => []
  let accepted = 0
  let durable = 0
  let due = 0
  let lastStart = -Infinity
  let timer: ReturnType<typeof setTimeout> | null = null
  let writing: Promise<void> | null = null
  let flushing = false

  const schedule = (): void => {
    if (timer !== null || writing || accepted === durable) {
      return
    }
    timer = setTimeout(
      () => {
        timer = null
        void drain()
      },
      Math.max(0, due - Date.now(), lastStart + SAVE_COALESCE_MS - Date.now())
    )
    timer.unref?.()
  }
  const drain = (): Promise<void> => {
    writing ??= Promise.resolve().then(async () => {
      try {
        do {
          const revision = accepted
          const payload = JSON.stringify({
            version: SCHEMA_VERSION,
            entries: Array.from(entries(), persistedEntry)
          })
          lastStart = Date.now()
          due = 0
          await mkdir(dirname(filePath), { recursive: true })
          const tmpPath = `${filePath}.tmp`
          await writeFile(tmpPath, payload, 'utf8')
          await rename(tmpPath, filePath)
          durable = revision
        } while (flushing && durable !== accepted)
      } catch (error) {
        due = 0
        console.warn('[agent-model-catalog] could not persist model lists:', error)
      } finally {
        writing = null
        flushing = false
        if (due) {
          schedule()
        }
      }
    })
    return writing
  }
  const flush = (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (accepted === durable) {
      return writing ?? Promise.resolve()
    }
    flushing = true
    return drain()
  }

  return {
    async load() {
      try {
        const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
        const root = asRecord(parsed)
        if (!root || root.version !== SCHEMA_VERSION || !Array.isArray(root.entries)) {
          return []
        }
        return root.entries
          .map(parseEntry)
          .filter((entry): entry is AgentModelCatalogEntry => entry !== null)
      } catch {
        return []
      }
    },
    save(source) {
      entries = source
      accepted++
      due ||= Date.now() + SAVE_COALESCE_MS
      schedule()
    },
    flush
  }
}
