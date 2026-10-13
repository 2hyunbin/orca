import type { PluginSyntaxPackMetadata } from '../../../../shared/plugins/plugin-syntax-pack'

export const PLUGIN_SYNTAX_SLOT_LIMIT = 512

export type PluginSyntaxSlot = {
  id: string
  key: string
  pack: PluginSyntaxPackMetadata
  language: PluginSyntaxPackMetadata['languages'][number]
}

export class PluginSyntaxSlotPool {
  private packs: readonly PluginSyntaxPackMetadata[] = []
  private readonly slots = new Map<string, PluginSyntaxSlot>()

  constructor(private readonly limit = PLUGIN_SYNTAX_SLOT_LIMIT) {}

  replace(packs: readonly PluginSyntaxPackMetadata[]): PluginSyntaxSlot[] {
    this.packs = packs
    const removed: PluginSyntaxSlot[] = []
    for (const [key, slot] of this.slots) {
      const pack = packs.find((candidate) => candidate.pluginKey === slot.pack.pluginKey)
      if (
        pack?.revision !== slot.pack.revision ||
        !pack.languages.some((item) => item.key === key)
      ) {
        this.slots.delete(key)
        removed.push(slot)
      }
    }
    return removed
  }

  claim(key: string): PluginSyntaxSlot | null {
    const current = this.slots.get(key)
    if (current) {
      return current
    }
    const pack = this.packs.find((item) => item.languages.some((language) => language.key === key))
    const language = pack?.languages.find((item) => item.key === key)
    if (!pack || !language || this.slots.size >= this.limit) {
      return null
    }
    const occupied = new Set([...this.slots.values()].map((slot) => slot.id))
    for (let index = 0; index < this.limit; index++) {
      const id = `orca-plugin-syntax-slot-${index}`
      if (!occupied.has(id)) {
        const slot = { id, key, pack, language }
        this.slots.set(key, slot)
        return slot
      }
    }
    return null
  }

  byId(id: string): PluginSyntaxSlot | null {
    return [...this.slots.values()].find((slot) => slot.id === id) ?? null
  }

  owns(slot: PluginSyntaxSlot): boolean {
    return this.slots.get(slot.key) === slot
  }
}

export function matchingPluginSyntaxLanguages(
  packs: readonly PluginSyntaxPackMetadata[],
  filePath: string
): PluginSyntaxPackMetadata['languages'] {
  const name = filePath.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? ''
  return packs.flatMap((pack) =>
    pack.languages.filter(
      (language) =>
        language.filenames.some((filename) => filename.toLowerCase() === name) ||
        language.extensions.some((extension) => name.endsWith(extension.toLowerCase()))
    )
  )
}

export function resolvePluginSyntaxLanguage(
  packs: readonly PluginSyntaxPackMetadata[],
  filePath: string,
  coreLanguage: string,
  chosenKey?: string
): string | null {
  if (chosenKey) {
    return packs.some((pack) => pack.languages.some((language) => language.key === chosenKey))
      ? chosenKey
      : null
  }
  if (coreLanguage !== 'plaintext') {
    const aliases = packs.flatMap((pack) =>
      pack.languages.filter((language) => language.builtInLanguage === coreLanguage)
    )
    return aliases.length === 1 ? aliases[0]!.key : null
  }
  const matches = matchingPluginSyntaxLanguages(packs, filePath)
  return matches.length === 1 ? matches[0]!.key : null
}
