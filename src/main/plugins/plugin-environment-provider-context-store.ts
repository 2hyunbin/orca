import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { lstat, opendir } from 'node:fs/promises'
import { z } from 'zod'
import {
  environmentRecipeJournalBindingSchema,
  type EnvironmentRecipeJournalBinding
} from '../../shared/plugins/plugin-environment-recipe-journal'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'
import { writeSecureFile } from '../../shared/secure-file'
import { withFileTransactionLock } from '../file-transaction-lock'
import { readContainedPluginArtifactText } from './plugin-artifact-file-reader'

const CONTEXT_BYTES = 4096
const contextSchema = z.strictObject({
  version: z.literal(1),
  binding: environmentRecipeJournalBindingSchema.extend({
    executionHostId: z.literal('local'),
    contextId: environmentRecipeJournalBindingSchema.shape.contextId.unwrap()
  }),
  createdAt: z.number().int().nonnegative()
})
export type PluginEnvironmentProviderContext = z.infer<typeof contextSchema>

/** Context changes encounter existing ownership; they never mint a parallel inventory. */
export class PluginEnvironmentProviderContextStore {
  private readonly directory: string

  constructor(userDataPath: string) {
    this.directory = join(userDataPath, 'plugin-environment-provider-contexts')
  }

  private filename(providerId: string): string {
    const parsed = environmentRecipeJournalBindingSchema.shape.providerId.parse(providerId)
    return `${createHash('sha256').update(parsed).digest('hex')}.json`
  }

  async list(): Promise<PluginEnvironmentProviderContext[]> {
    try {
      const info = await lstat(this.directory)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error('Saved provider contexts require a regular directory')
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return []
      }
      throw error
    }
    const records: PluginEnvironmentProviderContext[] = []
    const entries = await opendir(this.directory)
    let scanned = 0
    for await (const entry of entries) {
      if (++scanned > 4096) {
        throw new Error('Saved provider directory exceeds its entry limit')
      }
      if (!entry.name.endsWith('.json')) {
        continue
      }
      if (records.length >= 128 || !entry.isFile()) {
        throw new Error('Saved provider context count or file type is invalid')
      }
      const raw = await readContainedPluginArtifactText(this.directory, entry.name, CONTEXT_BYTES)
      assertJsonTextStructureWithinLimits(raw, { nestingDepth: 8, structuralTokens: 256 })
      const record = contextSchema.parse(JSON.parse(raw))
      if (entry.name !== this.filename(record.binding.providerId)) {
        throw new Error('Saved provider context filename belongs to another provider')
      }
      const current = await this.open(record.binding.providerId)
      if (!current || JSON.stringify(current.record) !== JSON.stringify(record)) {
        throw new Error('Saved provider context changed during enumeration')
      }
      records.push(record)
    }
    return records.sort((a, b) => a.binding.providerId.localeCompare(b.binding.providerId))
  }

  async read(providerId: string): Promise<PluginEnvironmentProviderContext | null> {
    return (await this.open(providerId))?.record ?? null
  }

  async open(providerId: string) {
    const filename = this.filename(providerId)
    let raw: string
    try {
      raw = await readContainedPluginArtifactText(this.directory, filename, CONTEXT_BYTES)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        // A dangling link is corruption, rather than an unconfigured account.
        try {
          lstatSync(join(this.directory, filename))
        } catch (entryError) {
          if (entryError instanceof Error && 'code' in entryError && entryError.code === 'ENOENT') {
            return null
          }
          throw entryError
        }
      }
      throw error
    }
    assertJsonTextStructureWithinLimits(raw, { nestingDepth: 8, structuralTokens: 256 })
    const record = contextSchema.parse(JSON.parse(raw))
    if (record.binding.providerId !== providerId || record.binding.executionHostId !== 'local') {
      throw new Error('Environment account context belongs to another provider or host')
    }
    const boundary = realpathSync(this.directory)
    const file = join(this.directory, filename)
    const isCurrent = (): boolean => {
      try {
        return (
          realpathSync(this.directory) === boundary &&
          lstatSync(file).isFile() &&
          readNodeFileSyncWithinLimit(file, CONTEXT_BYTES, {
            regularFileOnly: true
          }).buffer.toString('utf8') === raw
        )
      } catch {
        return false
      }
    }
    if (!isCurrent()) {
      throw new Error('Environment account context changed during its read')
    }
    return { record, isCurrent }
  }

  async configure(
    input: EnvironmentRecipeJournalBinding
  ): Promise<PluginEnvironmentProviderContext> {
    const binding = contextSchema.shape.binding.parse(structuredClone(input))
    const filename = this.filename(binding.providerId)
    return withFileTransactionLock(join(this.directory, filename), async () => {
      const existing = await this.read(binding.providerId)
      if (existing) {
        if (JSON.stringify(existing.binding) !== JSON.stringify(binding)) {
          throw new Error(
            'Changing provider source, commands or account context requires inventory migration'
          )
        }
        return existing
      }
      const record: PluginEnvironmentProviderContext = {
        version: 1,
        binding,
        createdAt: Date.now()
      }
      if (
        !writeSecureFile(join(this.directory, filename), JSON.stringify(record), { durable: true })
      ) {
        throw new Error('Environment account context permissions could not be restricted')
      }
      return record
    })
  }
  async replace(
    expectedInput: EnvironmentRecipeJournalBinding,
    nextInput: EnvironmentRecipeJournalBinding,
    authority: { isCurrent(): boolean }
  ): Promise<PluginEnvironmentProviderContext> {
    const expected = contextSchema.shape.binding.parse(structuredClone(expectedInput))
    const binding = contextSchema.shape.binding.parse(structuredClone(nextInput))
    if (
      expected.providerId !== binding.providerId ||
      expected.executionHostId !== binding.executionHostId ||
      !binding.journalId
    ) {
      throw new Error('Configuration migration names another provider, host or missing generation')
    }
    const file = join(this.directory, this.filename(binding.providerId))
    return withFileTransactionLock(file, async () => {
      const current = await this.open(binding.providerId)
      if (
        !current ||
        JSON.stringify(current.record.binding) !== JSON.stringify(expected) ||
        !current.isCurrent() ||
        !authority.isCurrent()
      ) {
        throw new Error('Configuration migration no longer owns the reviewed selection')
      }
      const record: PluginEnvironmentProviderContext = {
        version: 1,
        binding,
        createdAt: Date.now()
      }
      if (!writeSecureFile(file, JSON.stringify(record), { durable: true })) {
        throw new Error('Migrated account context could not be written securely')
      }
      return record
    })
  }
}
