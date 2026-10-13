import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginViewerRuntimeClient } from '../../shared/plugins/plugin-viewer-runtime-client'
import { runtimeViewerRpcFixture } from './runtime-plugin-viewer-rpc-test-fixture'
import { pluginViewerRuntimeObservationSchema } from '../../shared/plugins/plugin-viewer-runtime-document'
import { PLUGIN_VIEWER_RUNTIME_SELECTION_CAPABILITY } from '../../shared/plugins/plugin-viewer-runtime-capability'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

describe('pinned runtime viewer client against the actual encrypted host', () => {
  it('selects an outside file on the same verified socket and never sends its grant to the parser', async () => {
    const f = await runtimeViewerRpcFixture(cleanups)
    const filePath = join(f.root, 'outside.fixture')
    await writeFile(filePath, Buffer.from([42, 128, 255]))
    const select = vi.spyOn(f.runtime, 'selectRuntimePluginViewerFile')
    const open = vi.spyOn(f.runtime, 'openRuntimePluginViewerDocument')
    const client = new PluginViewerRuntimeClient(
      pairedRuntimeConnectionFromOffer(f.pairing),
      f.input.runtimeId,
      vi.fn()
    )
    cleanups.push(() => client.close())
    const file = await client.open(f.input.owner, filePath, new AbortController().signal, {
      userSelectedFile: true
    })
    expect(Object.keys(file).sort()).toEqual(['close', 'name', 'read', 'size'])
    expect(await file.read(0, 3, new AbortController().signal)).toEqual(Buffer.from([42, 128, 255]))
    expect(select).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(1)
    expect(select.mock.calls[0]?.[1].connectionId).toBe(open.mock.calls[0]?.[1].connectionId)
    expect(open.mock.calls[0]?.[0]).toMatchObject({ selectionGrantId: expect.any(String) })
    await file.close()
  })

  it('refuses a host without selection capability before issuing either select or open', async () => {
    const f = await runtimeViewerRpcFixture(cleanups)
    const status = f.runtime.getStatus()
    vi.spyOn(f.runtime, 'getStatus').mockReturnValue({
      ...status,
      capabilities: status.capabilities?.filter(
        (capability) => capability !== PLUGIN_VIEWER_RUNTIME_SELECTION_CAPABILITY
      )
    })
    const select = vi.spyOn(f.runtime, 'selectRuntimePluginViewerFile')
    const open = vi.spyOn(f.runtime, 'openRuntimePluginViewerDocument')
    const client = new PluginViewerRuntimeClient(
      pairedRuntimeConnectionFromOffer(f.pairing),
      f.input.runtimeId,
      vi.fn()
    )
    cleanups.push(() => client.close())
    await expect(
      client.open(f.input.owner, f.filePath, new AbortController().signal, {
        userSelectedFile: true
      })
    ).rejects.toMatchObject({ code: 'unsupported_host' })
    expect(select).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })
  it.each([false, true])('reads binary ranges and retires on close; folder=%s', async (folder) => {
    const f = await runtimeViewerRpcFixture(cleanups, 'runtime', folder)
    const invalidated = vi.fn()
    const client = new PluginViewerRuntimeClient(
      pairedRuntimeConnectionFromOffer(f.pairing),
      f.input.runtimeId,
      invalidated
    )
    cleanups.push(() => client.close())
    const file = await client.open(f.input.owner, f.filePath, new AbortController().signal)
    expect(file.name).toBe('binary.fixture')
    expect(file.size).toBe(4)
    expect(await file.read(1, 2, new AbortController().signal)).toEqual(Buffer.from([128, 255]))
    expect(await file.read(4, 1, new AbortController().signal)).toEqual(Buffer.alloc(0))
    await file.close()
    expect(invalidated).toHaveBeenCalledTimes(1)
    await expect(file.read(0, 1, new AbortController().signal)).rejects.toMatchObject({
      code: 'cancelled'
    })
    await expect(
      client.open(f.input.owner, f.filePath, new AbortController().signal)
    ).rejects.toMatchObject({
      code: 'unavailable'
    })
  })

  it.each([false, true])(
    'keeps the same host lease past connection idle and consumed-grant deadlines; selected=%s',
    async (selected) => {
      const f = await runtimeViewerRpcFixture(cleanups)
      const filePath = selected ? join(f.root, 'selected-idle.fixture') : f.filePath
      if (selected) {
        await writeFile(filePath, Buffer.from([0, 128, 255, 42]))
      }
      const client = new PluginViewerRuntimeClient(
        pairedRuntimeConnectionFromOffer(f.pairing),
        f.input.runtimeId,
        vi.fn()
      )
      cleanups.push(() => client.close())
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const file = await client.open(f.input.owner, filePath, new AbortController().signal, {
        userSelectedFile: selected
      })
      await vi.advanceTimersByTimeAsync(61_000)
      vi.useRealTimers()
      expect(await file.read(0, 4, new AbortController().signal)).toEqual(
        Buffer.from([0, 128, 255, 42])
      )
    }
  )

  it('retires on actual server socket loss and cannot reopen or replay that document', async () => {
    const f = await runtimeViewerRpcFixture(cleanups)
    const invalidated = vi.fn()
    const client = new PluginViewerRuntimeClient(
      pairedRuntimeConnectionFromOffer(f.pairing),
      f.input.runtimeId,
      invalidated
    )
    cleanups.push(() => client.close())
    const file = await client.open(f.input.owner, f.filePath, new AbortController().signal)
    await f.rpc.stop()
    await vi.waitFor(() => expect(invalidated).toHaveBeenCalledTimes(1))
    await expect(file.read(0, 1, new AbortController().signal)).rejects.toMatchObject({
      code: 'cancelled'
    })
    await expect(
      client.open(f.input.owner, f.filePath, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('rejects the wrong answering runtime before document admission', async () => {
    const f = await runtimeViewerRpcFixture(cleanups)
    const client = new PluginViewerRuntimeClient(
      pairedRuntimeConnectionFromOffer(f.pairing),
      'another-runtime',
      vi.fn()
    )
    cleanups.push(() => client.close())
    const opening = vi.spyOn(f.runtime, 'openRuntimePluginViewerDocument')
    await expect(
      client.open(f.input.owner, f.filePath, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'unauthorized' })
    expect(opening).not.toHaveBeenCalled()
  })

  it('closes a cancelled admission and restores every host reservation', async () => {
    const f = await runtimeViewerRpcFixture(cleanups)
    const controller = new AbortController()
    const client = new PluginViewerRuntimeClient(
      pairedRuntimeConnectionFromOffer(f.pairing),
      f.input.runtimeId,
      vi.fn()
    )
    cleanups.push(() => client.close())
    const pending = client.open(f.input.owner, f.filePath, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    for (let index = 0; index < 10; index++) {
      const next = new PluginViewerRuntimeClient(
        pairedRuntimeConnectionFromOffer(f.pairing),
        f.input.runtimeId,
        vi.fn()
      )
      cleanups.push(() => next.close())
      const file = await next.open(f.input.owner, f.filePath, new AbortController().signal)
      await file.close()
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
  })

  it('retires a mutated document before returning changed bytes', async () => {
    const f = await runtimeViewerRpcFixture(cleanups)
    const invalidated = vi.fn()
    const client = new PluginViewerRuntimeClient(
      pairedRuntimeConnectionFromOffer(f.pairing),
      f.input.runtimeId,
      invalidated
    )
    cleanups.push(() => client.close())
    const file = await client.open(f.input.owner, f.filePath, new AbortController().signal)
    await writeFile(f.filePath, 'changed')
    await expect(file.read(0, 4, new AbortController().signal)).rejects.toSatisfy(
      (error: { code: string }) => ['stale_revision', 'cancelled'].includes(error.code)
    )
    expect(invalidated).toHaveBeenCalledTimes(1)
  })

  it('retires an idle parser through the same authenticated socket when the host closes its lease', async () => {
    const f = await runtimeViewerRpcFixture(cleanups)
    const observation = vi.spyOn(f.runtime, 'observeRuntimePluginViewerDocument')
    const invalidated = vi.fn()
    const client = new PluginViewerRuntimeClient(
      pairedRuntimeConnectionFromOffer(f.pairing),
      f.input.runtimeId,
      invalidated
    )
    cleanups.push(() => client.close())
    const file = await client.open(f.input.owner, f.filePath, new AbortController().signal)
    const [lease, transport] = observation.mock.calls[0] ?? []
    if (!lease || !transport) {
      throw new Error('actual host observation unavailable')
    }
    expect(f.runtime.closeRuntimePluginViewerDocument(lease, transport)).toEqual({ ok: true })
    await vi.waitFor(() => expect(invalidated).toHaveBeenCalledTimes(1))
    await expect(file.read(0, 1, new AbortController().signal)).rejects.toMatchObject({
      code: 'cancelled'
    })
    await expect(
      client.open(f.input.owner, f.filePath, new AbortController().signal)
    ).rejects.toMatchObject({ code: 'unavailable' })
  })

  it.each(['lease', 'runtime', 'shape'] as const)(
    'fails closed for an invalid %s in the established lifecycle stream',
    async (mode) => {
      const f = await runtimeViewerRpcFixture(cleanups)
      const original = f.runtime.observeRuntimePluginViewerDocument.bind(f.runtime)
      const observation = vi
        .spyOn(f.runtime, 'observeRuntimePluginViewerDocument')
        .mockImplementation((input, transport, emit) =>
          original(input, transport, (raw) => {
            const event = pluginViewerRuntimeObservationSchema.parse(raw)
            emit(
              !event.closed
                ? event
                : mode === 'lease'
                  ? { ...event, leaseId: '00000000-0000-4000-8000-000000000001' }
                  : mode === 'runtime'
                    ? { ...event, runtimeId: 'other-runtime' }
                    : { ...event, extra: true }
            )
          })
        )
      const invalidated = vi.fn()
      const client = new PluginViewerRuntimeClient(
        pairedRuntimeConnectionFromOffer(f.pairing),
        f.input.runtimeId,
        invalidated
      )
      cleanups.push(() => client.close())
      const file = await client.open(f.input.owner, f.filePath, new AbortController().signal)
      const [lease, transport] = observation.mock.calls[0] ?? []
      if (!lease || !transport) {
        throw new Error('actual host observation unavailable')
      }
      f.runtime.closeRuntimePluginViewerDocument(lease, transport)
      await vi.waitFor(() => expect(invalidated).toHaveBeenCalledTimes(1))
      await expect(file.read(0, 1, new AbortController().signal)).rejects.toMatchObject({
        code: 'cancelled'
      })
    }
  )
})
