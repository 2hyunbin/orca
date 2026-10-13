import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  ENVIRONMENT_RECIPE_JOURNAL_BYTES,
  environmentRecipeJournalBindingSchema,
  environmentRecipeJournalSchema,
  type EnvironmentRecipeJournal,
  type EnvironmentRecipeJournalBinding
} from '../../shared/plugins/plugin-environment-recipe-journal'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { stringifyJsonWithinByteLimit } from '../../shared/node-bounded-json-stringify'
import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'
import { writeSecureFile } from '../../shared/secure-file'

export class PluginEnvironmentRecipeJournalFile {
  readonly filePath: string
  readonly binding: EnvironmentRecipeJournalBinding
  constructor(userDataPath: string, binding: EnvironmentRecipeJournalBinding) {
    this.binding = environmentRecipeJournalBindingSchema.parse(structuredClone(binding))
    const key = createHash('sha256')
      .update(JSON.stringify([this.binding.executionHostId, this.binding.providerId]))
      .digest('hex')
    this.filePath = this.binding.journalId
      ? join(
          userDataPath,
          'plugin-environment-recipes',
          'generations',
          key,
          `${this.binding.journalId}.json`
        )
      : join(userDataPath, 'plugin-environment-recipes', `${key}.json`)
  }
  async read(): Promise<EnvironmentRecipeJournal> {
    let raw: string
    try {
      raw = (
        await readNodeFileWithinLimit(this.filePath, ENVIRONMENT_RECIPE_JOURNAL_BYTES, {
          regularFileOnly: true
        })
      ).buffer.toString('utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        if (this.binding.journalId) {
          throw new Error('The selected migrated journal is missing')
        }
        return { version: 1, binding: { ...this.binding }, resources: [], operations: [] }
      }
      throw error
    }
    assertJsonTextStructureWithinLimits(raw, { nestingDepth: 16, structuralTokens: 512 * 1024 })
    const journal = environmentRecipeJournalSchema.parse(JSON.parse(raw))
    if (JSON.stringify(journal.binding) !== JSON.stringify(this.binding)) {
      throw new Error(
        'Environment journal belongs to different source, recipe, execution host or provider context'
      )
    }
    return journal
  }

  write(journal: EnvironmentRecipeJournal): void {
    const parsed = environmentRecipeJournalSchema.parse(journal)
    if (JSON.stringify(parsed.binding) !== JSON.stringify(this.binding)) {
      throw new Error('The journal write names another generation or owner')
    }
    const { serialized } = stringifyJsonWithinByteLimit(parsed, ENVIRONMENT_RECIPE_JOURNAL_BYTES)
    if (!writeSecureFile(this.filePath, serialized, { durable: true })) {
      throw new Error('Environment journal permissions could not be restricted')
    }
  }
}
