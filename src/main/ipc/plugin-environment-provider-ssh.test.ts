import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { EnvironmentProviderSshPreview } from '../../shared/plugins/plugin-environment-provider-ssh-api'
import type { SshTarget } from '../../shared/ssh-types'
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
  contextId: 'company/account',
  consentFingerprint: 'sha256-reviewed',
  reviewRevision: 'review-sha256-current',
  recipeDigest: 'a'.repeat(64)
}
function fixture() {
  const held = Promise.withResolvers<EnvironmentProviderSshPreview>()
  const signals: AbortSignal[] = []
  const ssh = {
    prepare: vi.fn(
      async (_owner: string, _review, _id: string, _rev: string, signal?: AbortSignal) => {
        if (signal) {
          signals.push(signal)
        }
        return held.promise
      }
    ),
    save: vi.fn(async (_owner: string, _ticket: string, _key?: string): Promise<SshTarget> => ({
      id: 'provider-one',
      label: 'Devbox',
      host: 'box.internal',
      port: 22,
      username: 'developer'
    })),
    revokeOwner: vi.fn()
  }
  const controller = new PluginEnvironmentProviderIpcController(
    {
      ssh,
      list: vi.fn(async () => []),
      configure: vi.fn(async () => []),
      snapshot: vi.fn(),
      execute: vi.fn()
    },
    (sender) => sender.id < 3
  )
  const input = { operationId: randomUUID(), review, resourceId: 'devbox', expectedRevision: 'r1' }
  const finish = (): void => {
    held.resolve({
      ticketId: randomUUID(),
      expiresAt: Date.now() + 300000,
      providerId: review.providerId,
      contextId: review.contextId,
      resource: {
        id: 'devbox',
        name: 'Devbox',
        revision: 'r1',
        state: 'running',
        lifetime: 'long-lived'
      }
    })
  }
  return { ssh, controller, signals, input, finish }
}
describe('provider SSH reviews use trusted window ownership', () => {
  it('refuses untrusted and forged prepare/save payloads before touching provider or SSH state', () => {
    const f = fixture()
    expect(() => f.controller.prepareSsh(new Sender(3), f.input)).toThrow('trusted app')
    expect(() =>
      f.controller.prepareSsh(new Sender(1), { ...f.input, connection: { host: 'forged' } })
    ).toThrow()
    expect(() =>
      f.controller.saveSsh(new Sender(1), { ticketId: randomUUID(), environmentProvider: {} })
    ).toThrow()
    expect(f.ssh.prepare).not.toHaveBeenCalled()
    expect(f.ssh.save).not.toHaveBeenCalled()
  })
  it('keeps ticket namespaces separate and withdraws old reviews on root navigation', async () => {
    const f = fixture()
    const one = new Sender(1),
      two = new Sender(2)
    const pending = f.controller.prepareSsh(one, f.input)
    f.finish()
    const preview = await pending
    const originalKey = f.ssh.prepare.mock.calls[0]![0]
    await f.controller.saveSsh(two, { ticketId: preview.ticketId })
    expect(f.ssh.save.mock.calls[0]![0]).not.toBe(originalKey)
    one.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(f.ssh.revokeOwner).not.toHaveBeenCalled()
    one.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(f.ssh.revokeOwner).toHaveBeenCalledWith(originalKey)
    await f.controller.saveSsh(one, { ticketId: preview.ticketId })
    expect(f.ssh.save.mock.calls[1]![0]).not.toBe(originalKey)
  })
  it('cancels only the requesting window’s inventory review and withdraws it on crash', async () => {
    const f = fixture()
    const one = new Sender(1)
    const pending = f.controller.prepareSsh(one, f.input)
    expect(f.controller.cancel(new Sender(2), { operationId: f.input.operationId })).toBe(false)
    expect(f.signals[0]?.aborted).toBe(false)
    one.emit('render-process-gone')
    expect(f.signals[0]?.aborted).toBe(true)
    expect(f.ssh.revokeOwner).toHaveBeenCalledOnce()
    f.finish()
    await expect(pending).rejects.toThrow('cancelled')
    expect(one.listenerCount('did-start-navigation')).toBe(0)
    expect(f.controller.cancel(one, { operationId: f.input.operationId })).toBe(false)
  })
})
