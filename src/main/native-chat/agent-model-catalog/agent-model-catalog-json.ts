import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { readStreamedSessionDocument } from '../../ai-vault/session-document-stream'
import type { agentModelCatalogCodec } from './agent-model-catalog-persistence'
import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'
import type { AgentModelCatalogEntry, AgentModelCatalogListing } from './agent-model-catalog-entry'

/** Private file I/O; the attached persistence drain serializes its operations. */
export function createAgentModelCatalogJson(
  directory: string,
  codec: typeof agentModelCatalogCodec
) {
  const path = join(directory, 'agent-model-catalog.json')
  const encodings = new WeakMap<AgentSessionModelOption[], string>()
  let version = 0
  let handle: FileHandle | null = null
  let temporary: string | null = null
  let loading: Promise<AgentModelCatalogEntry[]> | null = null
  const retire = async (): Promise<void> => {
    await handle?.close()
    handle = null
    if (temporary) {
      await unlink(temporary).catch(() => {})
      temporary = null
    }
  }
  const invalid = (): never => {
    throw new SyntaxError('Invalid model catalog document')
  }
  const read = (): Promise<AgentModelCatalogEntry[]> => {
    loading ??= (async () => {
      await retire()
      const stream = createReadStream(path, { highWaterMark: 64 * 1024 })
      try {
        const result = await readStreamedSessionDocument({
          bytes: stream,
          arrayKey: 'entries',
          fields: ['version'],
          includeArrayValidity: true,
          create: (): unknown[] => [],
          consume: (records, value) => {
            records.push(value)
          }
        })
        if (
          !result ||
          (result.record.version !== 3 && result.record.version !== 4) ||
          !result.arrayValid
        ) {
          return invalid()
        }
        const definitions: AgentSessionModelOption[][] = []
        const scopes: unknown[] = []
        const resolveModels = (id: unknown): AgentSessionModelOption[] => {
          if (
            typeof id !== 'number' ||
            !Number.isInteger(id) ||
            id < 0 ||
            id >= definitions.length
          ) {
            return invalid()
          }
          return definitions[id] ?? invalid()
        }
        if (result.record.version === 4) {
          for (const record of result.state) {
            if (!Array.isArray(record) || record.length !== 2) {
              return invalid()
            }
            if (record[0] === 'models') {
              const models = codec.parseModels(record[1])
              if (!models) {
                return invalid()
              }
              definitions.push(models)
            } else if (record[0] === 'scope') {
              const descriptor = codec.asRecord(record[1])
              for (const role of ['discovered', 'live']) {
                const source = descriptor?.[role]
                if (source !== null && source !== undefined) {
                  resolveModels(codec.asRecord(source)?.models)
                }
              }
              scopes.push(record[1])
            } else {
              return invalid()
            }
            await yieldToEventLoop()
          }
        }
        const rows = new Map<string, AgentModelCatalogEntry>()
        for (const value of result.record.version === 3 ? result.state : scopes) {
          const entry = codec.parseEntry(
            value,
            result.record.version === 3 ? undefined : resolveModels
          )
          if (entry && !rows.has(entry.fingerprint)) {
            rows.set(entry.fingerprint, entry)
          }
          await yieldToEventLoop()
        }
        version = result.record.version
        return [...rows.values()]
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          return []
        }
        throw error
      } finally {
        stream.destroy()
        await finished(stream).catch(() => {})
      }
    })().finally(() => {
      loading = null
    })
    return loading
  }
  const write = async (rows: AgentModelCatalogEntry[]): Promise<void> => {
    await loading
    await retire()
    await mkdir(directory, { recursive: true })
    const target = `${path}.${randomUUID()}.tmp`
    const writer = await open(target, 'wx')
    handle = writer
    temporary = target
    const definitions = new Map<string, { id: number; encoding: string }>()
    let separator = ''
    const emit = async (payload: string): Promise<void> => {
      await writer.writeFile(`${separator}${payload}`, 'utf8')
      separator = ','
    }
    const source = async (listing: AgentModelCatalogListing | null) => {
      if (!listing) {
        return null
      }
      let encoding = encodings.get(listing.models)
      if (encoding === undefined) {
        const models = codec.parseModels(listing.models)
        if (!models) {
          return invalid()
        }
        encoding = JSON.stringify(models)
      }
      let definition = definitions.get(encoding)
      if (!definition) {
        definition = { id: definitions.size, encoding }
        definitions.set(encoding, definition)
        await emit(`["models",${encoding}]`)
      }
      encodings.set(listing.models, definition.encoding)
      await yieldToEventLoop()
      return { ...listing, models: definition.id }
    }
    try {
      await writer.writeFile('{"version":4,"entries":[', 'utf8')
      for (const entry of rows) {
        const descriptor = {
          ...codec.persistedEntry(entry),
          discovered: await source(entry.discovered),
          live: await source(entry.live)
        }
        await emit(JSON.stringify(['scope', descriptor]))
        await yieldToEventLoop()
      }
      await writer.writeFile(']}', 'utf8')
      await writer.close()
      handle = null
      await rename(target, path)
      version = 4
    } finally {
      await retire()
    }
  }
  return { read, write, version: () => version }
}
