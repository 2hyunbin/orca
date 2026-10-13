import type { PluginManifest } from '../../shared/plugins/plugin-manifest'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'
import { PluginArtifactSnapshot } from './plugin-artifact-snapshot'
import { verifyInstructionalPluginContent } from './plugin-instructional-content-integrity'

export type PluginRecipeRegistration<Recipe> = { pluginKey: string; recipe: Recipe }
export type PluginRecipeAuthority<Recipe> = {
  registration: PluginRecipeRegistration<Recipe>
  plugin: ValidDiscoveredPlugin
  isCurrent(): boolean
  signal: AbortSignal
}
type RecipeAdmission<Recipe> = {
  controller: AbortController
  registration: PluginRecipeRegistration<Recipe>
  snapshot: PluginArtifactSnapshot
  artifactPath: string
  plugin: ValidDiscoveredPlugin
  isCurrent(): boolean
  canRead(): boolean
}
type RecipeLoadResult<Recipe> =
  | { pluginKey: string; entries: RecipeAdmission<Recipe>[] }
  | { pluginKey: string; error: string }

export class PluginRecipeArtifactRegistry<Recipe extends { id: string }> {
  private active: RecipeAdmission<Recipe>[] = []
  private readonly previews = new Map<string, PluginRecipeRegistration<Recipe>[]>()
  private readonly errors = new Map<string, string>()
  private generation = 0

  constructor(
    private readonly definition: {
      label: string
      maxBytes: number
      contributions(manifest: PluginManifest): readonly { path: string }[]
      parse(text: string): Recipe
      identity(pluginKey: string, recipe: Recipe): string
      canReadCurrentPlugin?: (plugin: ValidDiscoveredPlugin) => boolean
      preserveUnchangedAuthority?: boolean
    }
  ) {}

  list(): readonly PluginRecipeRegistration<Recipe>[] {
    return this.active
      .filter((entry) => entry.canRead())
      .map((entry) => structuredClone(entry.registration))
  }

  preview(pluginKey: string): readonly PluginRecipeRegistration<Recipe>[] {
    return structuredClone(this.previews.get(pluginKey) ?? [])
  }

  error(pluginKey: string): string | null {
    return this.errors.get(pluginKey) ?? null
  }

  invalidate(pluginKey?: string): void {
    this.generation += 1
    for (const entry of this.active) {
      if (pluginKey === undefined || entry.registration.pluginKey === pluginKey) {
        entry.controller.abort()
      }
    }
    this.active = this.active.filter((entry) => !entry.controller.signal.aborted)
  }

  invalidateUnavailable(): void {
    this.generation += 1
    this.active = this.active.filter((entry) => {
      if (entry.canRead()) {
        return true
      }
      entry.controller.abort()
      return false
    })
  }

  async resolve(identity: string): Promise<PluginRecipeRegistration<Recipe> | null> {
    return (await this.resolveAuthority(identity))?.registration ?? null
  }

  async resolveAuthority(identity: string): Promise<PluginRecipeAuthority<Recipe> | null> {
    const entry = this.active.find(
      (entry) =>
        entry.canRead() &&
        this.definition.identity(entry.registration.pluginKey, entry.registration.recipe) ===
          identity
    )
    if (!entry) {
      return null
    }
    try {
      await verifyInstructionalPluginContent(entry.plugin)
      await entry.snapshot.read(entry.artifactPath, this.definition.maxBytes)
    } catch (error) {
      if (!this.active.includes(entry)) {
        return null
      }
      const pluginKey = entry.registration.pluginKey
      for (const candidate of this.active) {
        if (candidate.registration.pluginKey === pluginKey) {
          candidate.controller.abort()
        }
      }
      this.active = this.active.filter(
        (candidate) => candidate.registration.pluginKey !== pluginKey
      )
      this.errors.set(pluginKey, error instanceof Error ? error.message : String(error))
      throw error
    }
    return entry.canRead()
      ? {
          registration: structuredClone(entry.registration),
          plugin: structuredClone(entry.plugin),
          isCurrent: () => this.active.includes(entry) && entry.canRead(),
          signal: entry.controller.signal
        }
      : null
  }

  async reconcile(
    discovered: readonly DiscoveredPlugin[],
    isApproved: (plugin: ValidDiscoveredPlugin) => boolean
  ): Promise<void> {
    if (this.definition.preserveUnchangedAuthority) {
      this.generation += 1
      this.active = this.active.filter((entry) => {
        const candidate = discovered.find(
          (plugin) => JSON.stringify(plugin) === JSON.stringify(entry.plugin)
        )
        if (!candidate || isInvalidDiscoveredPlugin(candidate) || !isApproved(candidate)) {
          entry.controller.abort()
          return false
        }
        const identity = JSON.stringify(candidate)
        entry.isCurrent = () =>
          !entry.controller.signal.aborted &&
          identity === JSON.stringify(candidate) &&
          isApproved(candidate)
        return true
      })
    } else {
      this.invalidate()
    }
    const generation = this.generation
    this.previews.clear()
    this.errors.clear()
    const candidates = discovered.filter(
      (plugin): plugin is ValidDiscoveredPlugin =>
        !isInvalidDiscoveredPlugin(plugin) &&
        this.definition.contributions(plugin.manifest).length > 0
    )
    const results = await mapWithConcurrency(
      candidates,
      4,
      async (plugin): Promise<RecipeLoadResult<Recipe>> => {
        const subject = structuredClone(plugin)
        const identity = JSON.stringify(subject)
        const approvedAtStart = isApproved(plugin)
        const snapshot = new PluginArtifactSnapshot(subject.rootDir, this.definition.label)
        const entries: RecipeAdmission<Recipe>[] = []
        try {
          const seen = new Set<string>()
          for (const contribution of this.definition.contributions(subject.manifest)) {
            const recipe = this.definition.parse(
              await snapshot.capture(contribution.path, this.definition.maxBytes)
            )
            if (seen.has(recipe.id)) {
              throw new Error(`duplicate ${this.definition.label} id "${recipe.id}"`)
            }
            seen.add(recipe.id)
            const controller = new AbortController()
            const isCurrent = () =>
              !controller.signal.aborted &&
              approvedAtStart &&
              identity === JSON.stringify(plugin) &&
              isApproved(plugin)
            const entry: RecipeAdmission<Recipe> = {
              controller,
              registration: { pluginKey: subject.pluginKey, recipe },
              snapshot,
              artifactPath: contribution.path,
              plugin: subject,
              isCurrent,
              canRead: () =>
                entry.isCurrent() && (this.definition.canReadCurrentPlugin?.(plugin) ?? true)
            }
            entries.push(entry)
          }
          await verifyInstructionalPluginContent(subject)
          for (const entry of entries) {
            await snapshot.read(entry.artifactPath, this.definition.maxBytes)
          }
          for (const entry of this.active.filter(
            (entry) => entry.registration.pluginKey === subject.pluginKey
          )) {
            await entry.snapshot.read(entry.artifactPath, this.definition.maxBytes)
          }
          if (identity !== JSON.stringify(plugin)) {
            throw new Error(`${this.definition.label} owner changed during admission`)
          }
          return { pluginKey: subject.pluginKey, entries }
        } catch (error) {
          if (generation === this.generation) {
            for (const entry of this.active) {
              if (entry.registration.pluginKey === subject.pluginKey) {
                entry.controller.abort()
              }
            }
            this.active = this.active.filter((entry) => !entry.controller.signal.aborted)
          }
          return {
            pluginKey: subject.pluginKey,
            error: error instanceof Error ? error.message : String(error)
          }
        }
      }
    )
    if (generation !== this.generation) {
      return
    }
    const approved: RecipeAdmission<Recipe>[] = []
    for (const result of results) {
      if ('error' in result) {
        this.errors.set(result.pluginKey, result.error)
      } else {
        this.previews.set(
          result.pluginKey,
          result.entries.map((entry) => entry.registration)
        )
        approved.push(...result.entries.filter((entry) => entry.isCurrent()))
      }
    }
    const owners = new Map<string, Set<string>>()
    for (const { registration } of approved) {
      const key = this.definition.identity(registration.pluginKey, registration.recipe)
      const names = owners.get(key) ?? new Set<string>()
      names.add(registration.pluginKey)
      owners.set(key, names)
    }
    const conflicted = new Set<string>()
    for (const [identity, names] of owners) {
      if (names.size > 1) {
        for (const pluginKey of names) {
          conflicted.add(pluginKey)
          this.errors.set(
            pluginKey,
            `${this.definition.label} id "${identity}" is contributed by multiple plugins`
          )
        }
      }
    }
    const next = approved
      .filter((entry) => !conflicted.has(entry.registration.pluginKey))
      .map((entry) => {
        const retained = this.active.find(
          (previous) =>
            previous.isCurrent() &&
            previous.artifactPath === entry.artifactPath &&
            JSON.stringify(previous.plugin) === JSON.stringify(entry.plugin) &&
            JSON.stringify(previous.registration) === JSON.stringify(entry.registration)
        )
        if (!retained) {
          return entry
        }
        retained.isCurrent = () => !retained.controller.signal.aborted && entry.isCurrent()
        return retained
      })
    for (const entry of this.active) {
      if (!next.includes(entry)) {
        entry.controller.abort()
      }
    }
    this.active = next
  }
}
