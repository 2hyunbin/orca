import type * as Monaco from 'monaco-editor'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  pluginSyntaxPackMetadataSchema,
  pluginSyntaxPackPayloadSchema
} from '../../../../shared/plugins/plugin-syntax-pack'
import { PluginSyntaxRuntime } from './plugin-syntax-runtime'
import type { PluginSyntaxFailure } from './plugin-grammar-failure'
import type { PluginGrammarWorker } from './plugin-grammar-worker-client'
import type { PluginGrammarRequest } from '../../../../shared/plugins/plugin-grammar-protocol'

vi.mock('./plugin-grammar.worker?worker', () => ({
  default: class implements PluginGrammarWorker {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null
    onerror: ((event: ErrorEvent) => void) | null = null
    terminate = vi.fn()
    postMessage(request: PluginGrammarRequest): void {
      queueMicrotask(() =>
        this.onmessage?.(
          new MessageEvent('message', {
            data: {
              type: 'complete',
              id: request.id,
              generation: request.generation,
              version: request.version,
              data: new Uint32Array()
            }
          })
        )
      )
    }
  }
}))
const runtimes: PluginSyntaxRuntime[] = []
afterEach(() => {
  runtimes.splice(0).forEach((runtime) => runtime.dispose())
  vi.useRealTimers()
})
const flush = async () => {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve()
  }
}

function pack(publisher = 'first', revision = 'one') {
  const metadata = pluginSyntaxPackMetadataSchema.parse({
    pluginKey: `${publisher}.syntax`,
    name: 'Test syntax',
    revision,
    languages: [
      {
        id: 'sample',
        key: `syntax:${publisher}.syntax/sample`,
        scopeName: 'source.sample',
        extensions: ['.sample']
      }
    ]
  })
  const payload = pluginSyntaxPackPayloadSchema.parse({
    ...metadata,
    languages: metadata.languages.map((language) => ({
      ...language,
      configuration: { brackets: [['(', ')']] }
    })),
    grammars: [
      { scopeName: 'source.sample', content: '{"scopeName":"source.sample","patterns":[]}' }
    ]
  })
  return { metadata, payload, key: metadata.languages[0]!.key }
}

function modelFixture(uri = 'file:///fixture.sample#host=local') {
  let language = 'plaintext'
  let text = 'word'
  let version = 1
  let disposed = false
  const languageChanges = new Set<() => void>()
  const contentChanges = new Set<() => void>()
  const removals = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    languageChanges.add(listener)
    return { dispose: () => languageChanges.delete(listener) }
  }
  const port = {
    uri: { toString: () => uri },
    getLanguageId: () => language,
    isDisposed: () => disposed,
    getValue: () => text,
    getValueLength: () => text.length,
    getLineCount: () => text.split('\n').length,
    getVersionId: () => version,
    onDidChangeLanguage: subscribe,
    onDidChangeContent: (listener: () => void) => {
      contentChanges.add(listener)
      return { dispose: () => contentChanges.delete(listener) }
    },
    onWillDispose: (listener: () => void) => {
      removals.add(listener)
      return { dispose: () => removals.delete(listener) }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture implements every model method used by the runtime; unused Monaco methods are never invoked.
  const model = port as unknown as Monaco.editor.ITextModel
  return {
    model,
    edit: (value: string) => {
      text = value
      version++
      for (const listener of contentChanges) {
        listener()
      }
    },
    dispose: () => {
      disposed = true
      for (const listener of removals) {
        listener()
      }
    },
    changeLanguage: (id: string) => {
      language = id
      for (const listener of languageChanges) {
        listener()
      }
    }
  }
}

function fixture(
  load: (metadata: ReturnType<typeof pack>['metadata']) => Promise<unknown>,
  onFailure?: (model: Monaco.editor.ITextModel, failure: PluginSyntaxFailure | null) => void
) {
  const model = modelFixture()
  const models = [model.model]
  let createModel: ((model: Monaco.editor.ITextModel) => void) | undefined
  const register = vi.fn()
  const setConfiguration = vi.fn(() => ({ dispose: vi.fn() }))
  const setTokens = vi.fn(() => ({ dispose: vi.fn() }))
  const port = {
    editor: {
      getModels: () => models,
      onDidCreateModel: (listener: (model: Monaco.editor.ITextModel) => void) => {
        createModel = listener
        return {
          dispose: () => {
            createModel = undefined
          }
        }
      },
      setModelLanguage: (_model: Monaco.editor.ITextModel, id: string) => model.changeLanguage(id),
      getDiffEditors: () => [],
      colorizeModelLine: () => ''
    },
    languages: {
      register,
      setLanguageConfiguration: setConfiguration,
      setTokensProvider: setTokens
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture implements the runtime's public Monaco calls; the tests exercise each lifecycle without browser rendering.
  const monaco = port as unknown as typeof Monaco
  const runtime = new PluginSyntaxRuntime(monaco, load, onFailure)
  runtimes.push(runtime)
  return {
    runtime,
    model,
    register,
    setConfiguration,
    setTokens,
    addModel: (uri: string) => {
      const added = modelFixture(uri)
      models.push(added.model)
      createModel?.(added.model)
      return added
    }
  }
}

describe('production syntax lifecycle and late responses', () => {
  it('registers only a host ID and loads grammar content only when a model uses the slot', async () => {
    const sample = pack()
    const load = vi.fn(async () => sample.payload)
    const context = fixture(load)
    context.runtime.replace([sample.metadata])
    expect(load).not.toHaveBeenCalled()
    const id = context.runtime.claim(sample.key)!
    expect(context.register).toHaveBeenCalledWith({ id })
    expect(load).not.toHaveBeenCalled()
    context.model.changeLanguage(id)
    await flush()
    expect(load).toHaveBeenCalledTimes(1)
    expect(context.setConfiguration).toHaveBeenCalledTimes(1)
    expect(context.model.model.getLanguageId()).toBe(id)
  })

  it('withdraws an open model before reusing its slot and ignores the prior owner response', async () => {
    const first = pack(),
      second = pack('second')
    let resolveOld = (_payload: unknown) => {}
    const old = new Promise<unknown>((resolve) => {
      resolveOld = resolve
    })
    const context = fixture((metadata) =>
      metadata.pluginKey === first.metadata.pluginKey ? old : Promise.resolve(second.payload)
    )
    context.runtime.replace([first.metadata])
    const oldId = context.runtime.claim(first.key)!
    context.model.changeLanguage(oldId)
    context.runtime.replace([second.metadata])
    expect(context.model.model.getLanguageId()).toBe('plaintext')
    const newId = context.runtime.claim(second.key)!
    expect(newId).toBe(oldId)
    context.model.changeLanguage(newId)
    await flush()
    expect(context.setConfiguration).toHaveBeenCalledTimes(1)
    resolveOld(first.payload)
    await flush()
    expect(context.setConfiguration).toHaveBeenCalledTimes(1)
    expect(context.register).toHaveBeenCalledTimes(1)
  })

  it('reloads an updated revision on an existing model even when its transient ID is reused', async () => {
    const first = pack(),
      updated = pack('first', 'two')
    const load = vi.fn((metadata: ReturnType<typeof pack>['metadata']) =>
      Promise.resolve(metadata.revision === 'one' ? first.payload : updated.payload)
    )
    const context = fixture(load)
    context.runtime.replace([first.metadata])
    const id = context.runtime.claim(first.key)!
    context.model.changeLanguage(id)
    await flush()
    context.runtime.replace([updated.metadata])
    await flush()
    expect(context.model.model.getLanguageId()).toBe(id)
    expect(load).toHaveBeenCalledTimes(2)
    expect(context.setConfiguration).toHaveBeenCalledTimes(2)
  })

  it('rejects a lazy payload with changed owner metadata and prevents disposal resurrection', async () => {
    const sample = pack()
    let resolve = (_payload: unknown) => {}
    const context = fixture(
      () =>
        new Promise<unknown>((done) => {
          resolve = done
        })
    )
    context.runtime.replace([sample.metadata])
    context.model.changeLanguage(context.runtime.claim(sample.key)!)
    resolve({ ...sample.payload, name: 'A different package preview' })
    await flush()
    expect(context.setConfiguration).not.toHaveBeenCalled()
    context.runtime.dispose()
    expect(context.model.model.getLanguageId()).toBe('plaintext')
    expect(context.runtime.claim(sample.key)).toBeNull()
  })
})

describe('model-owned failure recovery', () => {
  it('reports rejected content, reloads it on explicit retry and clears state without changing model text', async () => {
    vi.useFakeTimers()
    const sample = pack()
    const load = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(sample.payload)
    const failure = vi.fn()
    const context = fixture(load, failure)
    context.runtime.replace([sample.metadata])
    const id = context.runtime.claim(sample.key)!
    context.model.changeLanguage(id)
    await flush()
    await vi.advanceTimersByTimeAsync(50)
    context.model.edit('kept user edit')
    await flush()
    context.runtime.retry(context.model.model.uri.toString())
    await flush()
    expect(load).toHaveBeenCalledTimes(2)
    expect(failure).toHaveBeenCalledWith(context.model.model, {
      key: sample.key,
      revision: 'one',
      reason: 'load'
    })
    expect(failure).toHaveBeenLastCalledWith(context.model.model, null)
    expect(context.model.model.getValue()).toBe('kept user edit')
    expect(context.model.model.getLanguageId()).toBe(id)
  })

  it('does not report a load failure from a replaced or disposed generation', async () => {
    const sample = pack()
    let reject = (_reason: unknown) => {}
    const pending = new Promise((_, failed) => {
      reject = failed
    })
    const failure = vi.fn()
    const context = fixture(async () => pending, failure)
    context.runtime.replace([sample.metadata])
    context.model.changeLanguage(context.runtime.claim(sample.key)!)
    context.runtime.replace([])
    reject(new Error('old request failed'))
    await flush()
    expect(failure.mock.calls.every(([, status]) => status === null)).toBe(true)
    context.model.dispose()
    expect(failure).toHaveBeenLastCalledWith(context.model.model, null)
  })

  it('bounds active grammars, reports only the ninth model, and recovers when another model releases its grammar', async () => {
    vi.useFakeTimers()
    const samples = Array.from({ length: 9 }, (_, index) => pack(`owner${index}`))
    const failure = vi.fn()
    const context = fixture(
      async (metadata) =>
        samples.find((sample) => sample.metadata.pluginKey === metadata.pluginKey)!.payload,
      failure
    )
    context.runtime.replace(samples.map((sample) => sample.metadata))
    const models = [
      context.model,
      ...samples
        .slice(1)
        .map((_, index) => context.addModel(`file:///fixture${index}.sample#host=local`))
    ]
    models.forEach((model, index) =>
      model.changeLanguage(context.runtime.claim(samples[index].key)!)
    )
    await flush()
    expect(failure.mock.calls.filter(([, status]) => status !== null)).toEqual([
      [models[8].model, { key: samples[8].key, revision: 'one', reason: 'capacity' }]
    ])
    models[8].edit('still an ordinary editable file')
    await vi.advanceTimersByTimeAsync(100)
    expect(failure).toHaveBeenLastCalledWith(models[8].model, {
      key: samples[8].key,
      revision: 'one',
      reason: 'capacity'
    })
    expect(models[8].model.getValue()).toBe('still an ordinary editable file')
    models[0].changeLanguage('plaintext')
    await flush()
    context.runtime.retry(models[8].model.uri.toString())
    await flush()
    expect(failure).toHaveBeenLastCalledWith(models[8].model, null)
    expect(context.setConfiguration).toHaveBeenCalledTimes(9)
  })

  it('reports an oversized model without touching its text, clears it on language change, and fences another host with the same path', async () => {
    vi.useFakeTimers()
    const sample = pack()
    const failure = vi.fn()
    const context = fixture(async () => sample.payload, failure)
    const otherHost = context.addModel('file:///fixture.sample#host=ssh')
    context.runtime.replace([sample.metadata])
    const id = context.runtime.claim(sample.key)!
    context.model.changeLanguage(id)
    context.model.edit('x'.repeat(500_001))
    await flush()
    await vi.advanceTimersByTimeAsync(50)
    expect(failure).toHaveBeenLastCalledWith(context.model.model, {
      key: sample.key,
      revision: 'one',
      reason: 'size'
    })
    const reads = context.setTokens.mock.calls.length
    context.runtime.retry(otherHost.model.uri.toString())
    expect(context.setTokens).toHaveBeenCalledTimes(reads)
    expect(context.model.model.getValueLength()).toBe(500_001)
    context.model.changeLanguage('plaintext')
    expect(failure).toHaveBeenLastCalledWith(context.model.model, null)
  })
})
