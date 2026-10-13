import type * as Monaco from 'monaco-editor'
import {
  pluginSyntaxPackPayloadSchema,
  pluginSyntaxPackMetadataSchema,
  type PluginSyntaxPackMetadata,
  type PluginSyntaxPackPayload
} from '../../../../shared/plugins/plugin-syntax-pack'
import { PluginGrammarTaskScheduler } from './plugin-grammar-task-scheduler'
import { PluginSyntaxSlotPool, type PluginSyntaxSlot } from './plugin-syntax-slot-pool'
import { refreshPluginGrammarDiffTokens } from './plugin-grammar-diff-refresh'
import { createPluginSyntaxEngine, type PluginSyntaxEngine } from './plugin-syntax-engine'
import type { PluginGrammarFailureReason, PluginSyntaxFailure } from './plugin-grammar-failure'

export const PLUGIN_SYNTAX_ACTIVE_GRAMMAR_LIMIT = 8
type ModelWatch = {
  model: Monaco.editor.ITextModel
  engine: PluginSyntaxEngine | null
  timer?: ReturnType<typeof setTimeout>
  listeners: Monaco.IDisposable[]
}

export class PluginSyntaxRuntime {
  private readonly pool = new PluginSyntaxSlotPool()
  private readonly registered = new Set<string>()
  private readonly engines = new Map<PluginSyntaxSlot, PluginSyntaxEngine>()
  private readonly models = new Map<Monaco.editor.ITextModel, ModelWatch>()
  private readonly loads = new Map<
    PluginSyntaxPackMetadata,
    Promise<PluginSyntaxPackPayload | null>
  >()
  private readonly scheduler = new PluginGrammarTaskScheduler()
  private readonly modelCreation: Monaco.IDisposable
  private generation = 0
  private disposed = false

  constructor(
    private readonly monaco: typeof Monaco,
    private readonly loadPack: (pack: PluginSyntaxPackMetadata) => Promise<unknown>,
    private readonly onFailure: (
      model: Monaco.editor.ITextModel,
      failure: PluginSyntaxFailure | null
    ) => void = () => {}
  ) {
    this.modelCreation = monaco.editor.onDidCreateModel((model) => this.watch(model))
    for (const model of monaco.editor.getModels()) {
      this.watch(model)
    }
  }

  replace(packs: readonly PluginSyntaxPackMetadata[]): void {
    ++this.generation
    const replacedModels: { key: string; model: Monaco.editor.ITextModel }[] = []
    for (const slot of this.pool.replace(packs)) {
      this.engines.get(slot)?.dispose()
      this.engines.delete(slot)
      for (const model of this.models.keys()) {
        if (!model.isDisposed() && model.getLanguageId() === slot.id) {
          replacedModels.push({ key: slot.key, model })
          this.monaco.editor.setModelLanguage(model, 'plaintext')
          refreshPluginGrammarDiffTokens(this.monaco, model)
        }
      }
    }
    for (const { key, model } of replacedModels) {
      const id = this.claim(key)
      if (id && !model.isDisposed()) {
        this.monaco.editor.setModelLanguage(model, id)
      }
    }
    for (const pack of this.loads.keys()) {
      if (!packs.includes(pack)) {
        this.loads.delete(pack)
      }
    }
  }

  claim(key: string): string | null {
    if (this.disposed) {
      return null
    }
    const slot = this.pool.claim(key)
    if (!slot) {
      return null
    }
    if (!this.registered.has(slot.id)) {
      this.monaco.languages.register({ id: slot.id })
      this.registered.add(slot.id)
    }
    return slot.id
  }

  dispose(): void {
    this.disposed = true
    this.replace([])
    this.modelCreation.dispose()
    for (const watch of this.models.values()) {
      clearTimeout(watch.timer)
      watch.listeners.forEach((listener) => listener.dispose())
    }
    this.models.clear()
  }

  private watch(model: Monaco.editor.ITextModel): void {
    const watch: ModelWatch = { model, engine: null, listeners: [] }
    this.models.set(model, watch)
    watch.listeners.push(
      model.onDidChangeLanguage(() => this.bind(watch)),
      model.onDidChangeContent(() => this.schedule(watch)),
      model.onWillDispose(() => {
        this.unbind(watch)
        this.models.delete(model)
        watch.listeners.forEach((listener) => listener.dispose())
      })
    )
    this.bind(watch)
  }

  private bind(watch: ModelWatch): void {
    this.unbind(watch)
    if (watch.model.isDisposed()) {
      return
    }
    const slot = this.pool.byId(watch.model.getLanguageId())
    if (!slot || this.disposed) {
      return
    }
    let engine = this.engines.get(slot)
    if (!engine) {
      if (this.engines.size >= PLUGIN_SYNTAX_ACTIVE_GRAMMAR_LIMIT) {
        this.report(watch.model, slot, 'capacity')
        return
      }
      engine = createPluginSyntaxEngine({
        monaco: this.monaco,
        slot,
        generation: this.generation,
        scheduler: this.scheduler,
        load: () => this.load(slot),
        current: () => this.pool.owns(slot) && !this.disposed,
        onFailure: (model, reason) => this.report(model, slot, reason)
      })
      this.engines.set(slot, engine)
    }
    watch.engine = engine
    this.schedule(watch)
  }

  private unbind(watch: ModelWatch): void {
    clearTimeout(watch.timer)
    this.onFailure(watch.model, null)
    const engine = watch.engine
    watch.engine = null
    engine?.cancel(watch.model)
    if (engine && ![...this.models.values()].some((item) => item.engine === engine)) {
      engine.dispose()
      this.engines.delete(engine.slot)
      queueMicrotask(() => {
        for (const candidate of this.models.values()) {
          if (
            !candidate.engine &&
            !candidate.model.isDisposed() &&
            this.pool.byId(candidate.model.getLanguageId())
          ) {
            this.bind(candidate)
          }
        }
      })
    }
  }

  private schedule(watch: ModelWatch): void {
    clearTimeout(watch.timer)
    watch.engine?.cancel(watch.model)
    this.onFailure(watch.model, null)
    watch.timer = setTimeout(() => {
      if (!watch.model.isDisposed()) {
        if (watch.engine) {
          watch.engine.warm(watch.model)
        } else {
          this.bind(watch)
        }
      }
    }, 50)
  }

  private load(slot: PluginSyntaxSlot): Promise<PluginSyntaxPackPayload | null> {
    let pending = this.loads.get(slot.pack)
    if (!pending) {
      pending = this.loadPack(slot.pack)
        .then((raw) => {
          const parsed = pluginSyntaxPackPayloadSchema.safeParse(raw)
          if (!parsed.success) {
            return null
          }
          const { grammars: _grammars, languages, ...metadata } = parsed.data
          const loaded = {
            ...metadata,
            languages: languages.map(({ configuration: _configuration, ...language }) => language)
          }
          return JSON.stringify(loaded) ===
            JSON.stringify(pluginSyntaxPackMetadataSchema.parse(slot.pack))
            ? parsed.data
            : null
        })
        .catch(() => null)
        .then((result) => {
          if (this.loads.get(slot.pack) === pending) {
            this.loads.delete(slot.pack)
          }
          return result
        })
      this.loads.set(slot.pack, pending)
    }
    return pending
  }

  retry(modelUri: string): void {
    for (const watch of this.models.values()) {
      if (!watch.model.isDisposed() && watch.model.uri.toString() === modelUri) {
        this.onFailure(watch.model, null)
        if (watch.engine) {
          watch.engine.retry(watch.model)
        } else {
          this.bind(watch)
        }
      }
    }
  }

  private report(
    model: Monaco.editor.ITextModel,
    slot: PluginSyntaxSlot,
    reason?: PluginGrammarFailureReason
  ): void {
    if (
      !this.disposed &&
      this.pool.owns(slot) &&
      !model.isDisposed() &&
      model.getLanguageId() === slot.id &&
      this.models.has(model)
    ) {
      this.onFailure(model, reason ? { key: slot.key, revision: slot.pack.revision, reason } : null)
    }
  }
}
