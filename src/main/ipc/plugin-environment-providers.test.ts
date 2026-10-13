import type {
  PluginEnvironmentProviderRecoverRequest,
  PluginEnvironmentProviderRecoveryResult
} from '../../shared/plugins/plugin-environment-provider-recovery-api'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { PluginEnvironmentProviderService } from '../plugins/plugin-environment-provider-service'
import type { JournaledEnvironmentRecipeResult } from '../../shared/plugins/plugin-environment-recipe-result'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
import { PluginEnvironmentProviderIpcController } from './plugin-environment-providers'

class Sender extends EventEmitter {
  constructor(readonly id: number) {
    super()
  }
  getType(): 'window' {
    return 'window'
  }
  getURL(): string {
    return 'file:///orca/index.html'
  }
  isDestroyed(): boolean {
    return false
  }
}
const review = {
  providerId: 'company.platform/pods',
  contextId: 'company/account/region',
  consentFingerprint: 'sha256-reviewed',
  reviewRevision: 'review-sha256-current',
  recipeDigest: 'a'.repeat(64)
}
function request() {
  return {
    protocolVersion: 2,
    providerId: review.providerId,
    contextId: review.contextId,
    operationId: randomUUID(),
    action: 'list'
  }
}
function harness() {
  const held = Promise.withResolvers<JournaledEnvironmentRecipeResult>()
  const signals: AbortSignal[] = []
  const service = {
    list: vi.fn(async () => []),
    listSaved: vi.fn(async () => []),
    savedSnapshot: vi.fn<PluginEnvironmentProviderService['savedSnapshot']>(),
    configure: vi.fn(async () => []),
    snapshot: vi.fn(async () => ({
      version: 1 as const,
      binding: {
        executionHostId: 'local',
        providerId: review.providerId,
        contextId: review.contextId,
        sourceDigest: 'a'.repeat(64),
        recipeDigest: review.recipeDigest
      },
      resources: [],
      operations: []
    })),
    execute: vi.fn(async (_review, _request, signal?: AbortSignal) => {
      if (!signal) {
        throw new Error('Missing owner cancellation signal')
      }
      signals.push(signal)
      return held.promise
    })
  } satisfies Pick<
    PluginEnvironmentProviderService,
    'list' | 'listSaved' | 'savedSnapshot' | 'configure' | 'snapshot' | 'execute'
  >
  const controller = new PluginEnvironmentProviderIpcController(
    service,
    (sender) => sender.id === 1 || sender.id === 2
  )
  const finish = (): void => {
    held.resolve({
      kind: 'recorded',
      operation: {
        operationId: randomUUID(),
        requestDigest: 'b'.repeat(64),
        action: 'list',
        startedAt: 0,
        status: 'pending'
      }
    })
  }
  return { service, controller, signals, finish }
}

describe('provider IPC is bound to the trusted requesting renderer', () => {
  it('keeps saved history behind trusted sender and strict provider/generation parsing', async () => {
    const { service, controller } = harness()
    expect(() => controller.listSaved(new Sender(3))).toThrow('trusted')
    expect(() =>
      controller.savedSnapshot(new Sender(3), { providerId: review.providerId })
    ).toThrow('trusted')
    expect(service.listSaved).not.toHaveBeenCalled()
    expect(service.savedSnapshot).not.toHaveBeenCalled()
    expect(() =>
      controller.savedSnapshot(new Sender(1), { providerId: review.providerId, offset: 129 })
    ).toThrow()
    expect(service.savedSnapshot).not.toHaveBeenCalled()
    await controller.listSaved(new Sender(1))
    controller.savedSnapshot(new Sender(1), { providerId: review.providerId })
    expect(service.listSaved).toHaveBeenCalledOnce()
    expect(service.savedSnapshot).toHaveBeenCalledExactlyOnceWith({
      providerId: review.providerId,
      offset: 0
    })
  })
  it('rejects untrusted windows and unknown execution/configuration fields before touching host state', async () => {
    const f = harness()
    const untrusted = new Sender(3)
    expect(() => f.controller.list(untrusted)).toThrow('trusted app')
    expect(() => f.controller.configure(untrusted, review)).toThrow('trusted app')
    await expect(f.controller.execute(untrusted, { review, request: request() })).rejects.toThrow(
      'trusted app'
    )
    const trusted = new Sender(1)
    expect(() => f.controller.configure(trusted, { ...review, cwd: '/caller/path' })).toThrow()
    await expect(
      f.controller.execute(trusted, { review, request: request(), env: { SECRET: 'caller' } })
    ).rejects.toThrow()
    expect(f.service.list).not.toHaveBeenCalled()
    expect(f.service.configure).not.toHaveBeenCalled()
    expect(f.service.execute).not.toHaveBeenCalled()
  })
  it('refuses another renderer’s cancellation and releases owner listeners after completion', async () => {
    const f = harness()
    const owner = new Sender(1)
    const req = request()
    const operation = f.controller.execute(owner, { review, request: req })
    expect(f.controller.cancel(new Sender(2), { operationId: req.operationId })).toBe(false)
    expect(f.signals[0]?.aborted).toBe(false)
    expect(f.controller.cancel(owner, { operationId: req.operationId })).toBe(true)
    expect(f.signals[0]?.aborted).toBe(true)
    f.finish()
    await operation
    expect(owner.eventNames()).toEqual([])
    expect(f.controller.cancel(owner, { operationId: req.operationId })).toBe(false)
  })
  it.each(['destroyed', 'render-process-gone'])(
    'withdraws %s work without leaking listeners',
    async (event) => {
      const f = harness()
      const owner = new Sender(1)
      const operation = f.controller.execute(owner, { review, request: request() })
      owner.emit(event)
      expect(f.signals[0]?.aborted).toBe(true)
      f.finish()
      await operation
      expect(owner.eventNames()).toEqual([])
    }
  )
  it('keeps child-frame and same-document navigation alive but withdraws a main-document reload', async () => {
    const f = harness()
    const owner = new Sender(1)
    const operation = f.controller.execute(owner, { review, request: request() })
    owner.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(f.signals[0]?.aborted).toBe(false)
    owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(f.signals[0]?.aborted).toBe(true)
    f.finish()
    await operation
    expect(owner.eventNames()).toEqual([])
  })
  it('bounds simultaneous operations and cannot replace a live operation identity', async () => {
    const f = harness()
    const owner = new Sender(1)
    const first = request()
    const pending = [f.controller.execute(owner, { review, request: first })]
    await expect(f.controller.execute(new Sender(2), { review, request: first })).rejects.toThrow(
      'already in progress'
    )
    for (let i = 1; i < 8; i++) {
      pending.push(f.controller.execute(owner, { review, request: request() }))
    }
    await expect(f.controller.execute(owner, { review, request: request() })).rejects.toThrow(
      'Too many'
    )
    expect(f.service.execute).toHaveBeenCalledTimes(8)
    f.finish()
    await Promise.all(pending)
    expect(owner.eventNames()).toEqual([])
  })
  it('rejects injected recovery receipts and binds inspection cancellation to its requesting window', async () => {
    const f = harness()
    const held = Promise.withResolvers<PluginEnvironmentProviderRecoveryResult>()
    const signals: AbortSignal[] = []
    const recover = vi.fn(
      async (_input: PluginEnvironmentProviderRecoverRequest, signal?: AbortSignal) => {
        if (signal) {
          signals.push(signal)
        }
        return held.promise
      }
    )
    const controller = new PluginEnvironmentProviderIpcController(
      { ...f.service, recover },
      (sender) => sender.id < 3
    )
    const input = { review, queryId: randomUUID(), originalOperationId: randomUUID() }
    expect(() => controller.recover(new Sender(3), input)).toThrow('trusted app')
    expect(() =>
      controller.recover(new Sender(1), { ...input, receipt: { kind: 'completed' } })
    ).toThrow()
    expect(recover).not.toHaveBeenCalled()
    const owner = new Sender(1)
    const pending = controller.recover(owner, input)
    expect(controller.cancel(new Sender(2), { operationId: input.queryId })).toBe(false)
    expect(signals[0]?.aborted).toBe(false)
    owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(signals[0]?.aborted).toBe(true)
    held.resolve({
      kind: 'known',
      operation: {
        operationId: input.originalOperationId,
        requestDigest: 'b'.repeat(64),
        action: 'create',
        startedAt: 1,
        status: 'completed',
        finishedAt: 2,
        resultDigest: 'c'.repeat(64)
      }
    })
    await pending
    expect(owner.listenerCount('did-start-navigation')).toBe(0)
  })
  it.each(['destroyed', 'render-process-gone', 'did-start-navigation'])(
    'binds migration reviews and consumption to the requesting window across %s',
    async (event) => {
      const f = harness()
      const held = Promise.withResolvers<never>()
      const signals: AbortSignal[] = []
      const prepareMigration = vi.fn(
        async (_owner: string, _input: unknown, signal?: AbortSignal) => {
          if (signal) {
            signals.push(signal)
          }
          return held.promise
        }
      )
      const commitMigration = vi.fn(async (_owner: string, _input: { ticketId: string }) => []),
        revokeMigrationOwner = vi.fn()
      const controller = new PluginEnvironmentProviderIpcController(
        { ...f.service, prepareMigration, commitMigration, revokeMigrationOwner },
        (sender) => sender.id < 3
      )
      const owner = new Sender(1),
        other = new Sender(2)
      const input = { review, queryId: randomUUID() }
      expect(() => controller.prepareMigration(new Sender(3), input)).toThrow('trusted app')
      expect(() =>
        controller.prepareMigration(owner, { ...input, env: { TOKEN: 'injected' } })
      ).toThrow()
      expect(() =>
        controller.commitMigration(owner, { ticketId: randomUUID(), journalId: randomUUID() })
      ).toThrow()
      expect(prepareMigration).not.toHaveBeenCalled()
      const pending = controller.prepareMigration(owner, input)
      const ownerKey = prepareMigration.mock.calls[0]?.[0]
      expect(controller.cancel(other, { operationId: input.queryId })).toBe(false)
      const ticketId = randomUUID()
      await controller.commitMigration(owner, { ticketId })
      expect(commitMigration).toHaveBeenLastCalledWith(ownerKey, { ticketId })
      await controller.commitMigration(other, { ticketId })
      expect(commitMigration.mock.calls[1]?.[0]).not.toBe(ownerKey)
      owner.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
      owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
      expect(signals[0]?.aborted).toBe(false)
      expect(revokeMigrationOwner).not.toHaveBeenCalled()
      owner.emit(event, { isMainFrame: true, isSameDocument: false })
      expect(signals[0]?.aborted).toBe(true)
      expect(revokeMigrationOwner).toHaveBeenCalledWith(ownerKey)
      held.reject(new Error('cancelled'))
      await expect(pending).rejects.toThrow('cancelled')
      expect(owner.eventNames()).toEqual([])
    }
  )
})
