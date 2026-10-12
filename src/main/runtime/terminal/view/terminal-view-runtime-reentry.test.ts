import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeTerminalBufferSnapshot } from '../../runtime-terminal-state-records'
import type { PtyProviderBufferSnapshot } from '../../../providers/types'
import type { RuntimeNotifier } from '../../runtime-notifier-contract'

const snapshot: RuntimeTerminalBufferSnapshot = { data: 'screen', cols: 80, rows: 24 }

function notifier(renameTerminal: RuntimeNotifier['renameTerminal']): RuntimeNotifier {
  return {
    worktreesChanged() {},
    reposChanged() {},
    activateWorktree() {},
    createTerminal() {},
    splitTerminal() {},
    renameTerminal,
    focusTerminal() {},
    closeTerminal() {},
    sleepWorktree() {},
    terminalFitOverrideChanged() {},
    terminalDriverChanged() {}
  }
}

describe('terminal view runtime re-entry', () => {
  it('returns the current available-state promise with the runtime receiver and original arity', () => {
    const runtime = new OrcaRuntimeService()
    const expected = Promise.resolve(snapshot)
    const receivers: OrcaRuntimeService[] = []
    const arities: number[] = []
    runtime['serializeTerminalBufferFromAvailableState'] = function (
      this: OrcaRuntimeService,
      ...args
    ) {
      receivers.push(this)
      arities.push(args.length)
      expect(args).toEqual(['view-pty', {}])
      return expected
    }
    expect(runtime.serializeTerminalBuffer('view-pty')).toBe(expected)
    expect(receivers).toEqual([runtime])
    expect(arities).toEqual([2])
  })

  it('reads the current fallback after provider completion and keeps provider-first options', async () => {
    const runtime = new OrcaRuntimeService()
    const provider = Promise.withResolvers<PtyProviderBufferSnapshot | null>()
    const receivers: OrcaRuntimeService[] = []
    const opts = { scrollbackRows: 12 }
    runtime['serializeProviderTerminalBuffer'] = function (this: OrcaRuntimeService, ...args) {
      receivers.push(this)
      expect(args).toEqual(['view-pty', opts, { timeoutMs: 8000, retireOnTimeout: true }])
      return provider.promise
    }
    const firstFallback = vi.fn(async () => null)
    runtime['serializeTerminalBufferFromAvailableState'] = firstFallback
    const pending = runtime.serializeAuthoritativeTerminalBuffer('view-pty', opts)
    runtime['serializeTerminalBufferFromAvailableState'] = function (
      this: OrcaRuntimeService,
      ...args
    ) {
      receivers.push(this)
      expect(args).toEqual(['view-pty', opts])
      return Promise.resolve(snapshot)
    }
    provider.resolve(null)
    await expect(pending).resolves.toBe(snapshot)
    expect(firstFallback).not.toHaveBeenCalled()
    expect(receivers).toEqual([runtime, runtime])
  })

  it('skips driver reads for empty input and rechecks the current driver before a write', async () => {
    const runtime = new OrcaRuntimeService()
    const initialDriver = vi.fn(() => ({ kind: 'desktop' as const }))
    runtime.getDriver = initialDriver
    await expect(runtime.writeTerminalPreviewInput('view-pty', '')).resolves.toBe(false)
    expect(initialDriver).not.toHaveBeenCalled()
    const receivers: OrcaRuntimeService[] = []
    runtime['writeTerminalInputChunks'] = async function (this: OrcaRuntimeService, ...args) {
      receivers.push(this)
      expect(args.length).toBe(3)
      expect(args[2].inputKind).toBe('driving')
      runtime.getDriver = function (this: OrcaRuntimeService) {
        receivers.push(this)
        return { kind: 'mobile', clientId: 'phone' }
      }
      await args[2].beforeWrite?.(args[0])
      return undefined
    }
    await expect(runtime.writeTerminalPreviewInput('view-pty', 'paste')).resolves.toBe(false)
    expect(initialDriver).toHaveBeenCalledOnce()
    expect(receivers).toEqual([runtime, runtime])
  })

  it('keeps rename persistence before the current notifier with its own receiver', async () => {
    const runtime = new OrcaRuntimeService()
    const pty = runtime['recordPtyWorktree']('rename-pty', 'folder-workspace', {
      tabId: 'host-tab'
    })
    const handle = runtime['issuePtyHandle'](pty)
    const receivers: OrcaRuntimeService[] = []
    const events: string[] = []
    const replacement = notifier(function (this: RuntimeNotifier, tabId, title) {
      expect(this).toBe(replacement)
      expect([tabId, title]).toEqual(['host-tab', 'Pinned'])
      events.push('replacement')
    })
    runtime.setNotifier(notifier(() => events.push('original')))
    runtime['persistHeadlessTerminalTitle'] = function (this: OrcaRuntimeService, ...args) {
      receivers.push(this)
      expect(args).toEqual(['folder-workspace', 'host-tab', 'Pinned'])
      events.push('persist')
      runtime.setNotifier(replacement)
    }
    runtime['touchMobileSessionSnapshotsForPty'] = function (this: OrcaRuntimeService, ptyId) {
      receivers.push(this)
      expect(ptyId).toBe('rename-pty')
      expect(pty.title).toBe('Pinned')
      expect(pty.titleUpdatedAt).toBeGreaterThan(0)
      events.push('touch')
    }
    await expect(runtime.renameTerminal(handle, 'Pinned')).resolves.toEqual({
      handle,
      tabId: 'host-tab',
      title: 'Pinned'
    })
    expect(events).toEqual(['touch', 'persist', 'replacement'])
    expect(receivers).toEqual([runtime, runtime])
    runtime.onPtyExit('rename-pty', 0)
  })
})

describe('terminal view at the Runtime constructor getter seam', () => {
  const cases = [
    ['headless-state', 'sync', false],
    ['preview-input', 'promise', false],
    ['available-buffer', 'promise', null],
    ['authoritative-buffer', 'promise', null]
  ] as const
  type Query = (typeof cases)[number][0] | 'rename'
  type Observation =
    | { kind: 'sync'; value: unknown }
    | { kind: 'promise'; value: unknown }
    | { kind: 'rejected'; error: unknown }
    | { kind: 'thrown'; error: unknown }

  class ViewConstructionRuntime extends OrcaRuntimeService {
    queryAtConstruction(query: Query): unknown {
      switch (query) {
        case 'headless-state':
          return this.hasHeadlessTerminalState('missing')
        case 'preview-input':
          return this.writeTerminalPreviewInput('missing', '')
        case 'available-buffer':
          return this.serializeTerminalBuffer('missing')
        case 'authoritative-buffer':
          return this.serializeAuthoritativeTerminalBuffer('missing')
        case 'rename':
          return this.renameTerminal('missing', 'title')
      }
    }
  }

  function readDuringConstruction(query: Query): Promise<Observation> {
    let observation: Observation | undefined
    let pending: Promise<Observation> | undefined
    let reads = 0
    class ConstructionProbe extends ViewConstructionRuntime {
      protected override get canonicalFetchKeyCache(): ReadonlyMap<string, string> {
        reads += 1
        try {
          const value = this.queryAtConstruction(query)
          if (value instanceof Promise) {
            pending = value.then(
              (resolved) => ({ kind: 'promise', value: resolved }),
              (error: unknown) => ({ kind: 'rejected', error })
            )
          } else {
            observation = { kind: 'sync', value }
          }
        } catch (error) {
          observation = { kind: 'thrown', error }
        }
        return super.canonicalFetchKeyCache
      }
    }
    new ConstructionProbe(null)
    expect(reads).toBe(1)
    if (pending) {
      return pending
    }
    if (!observation) {
      throw new Error('Constructor seam did not produce an observation')
    }
    return Promise.resolve(observation)
  }

  it.each(cases)('keeps %s available before derived initialization', async (query, kind, value) => {
    expect(await readDuringConstruction(query)).toEqual({ kind, value })
  })

  it('keeps rename refusal asynchronous before derived initialization', async () => {
    const observation = await readDuringConstruction('rename')
    expect(observation.kind).toBe('rejected')
    if (observation.kind === 'rejected') {
      expect(observation.error).toBeInstanceOf(Error)
      expect(observation.error).toMatchObject({ message: 'runtime_unavailable' })
    }
  })
})
