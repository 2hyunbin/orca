import { describe, expect, it, vi } from 'vitest'
import { RuntimePluginViewerLeaseObserver } from './runtime-plugin-viewer-lease-observer'

describe('bounded runtime viewer lease observation', () => {
  it('acknowledges once and completes only when the lease closes', async () => {
    const observer = new RuntimePluginViewerLeaseObserver()
    const emit = vi.fn()
    const waiting = observer.observe(emit, new AbortController().signal)
    expect(emit.mock.calls).toEqual([[false]])
    observer.close()
    await waiting
    expect(emit.mock.calls).toEqual([[false], [true]])
    observer.close()
    expect(emit).toHaveBeenCalledTimes(2)
  })

  it('denies a second observer without cancelling the original one', async () => {
    const observer = new RuntimePluginViewerLeaseObserver()
    const emit = vi.fn()
    const waiting = observer.observe(emit, new AbortController().signal)
    await expect(observer.observe(vi.fn(), new AbortController().signal)).rejects.toMatchObject({
      code: 'limit_exceeded'
    })
    expect(emit.mock.calls).toEqual([[false]])
    observer.close()
    await waiting
    expect(emit.mock.calls).toEqual([[false], [true]])
  })

  it.each(['before', 'after'] as const)('settles cancellation %s admission', async (when) => {
    const observer = new RuntimePluginViewerLeaseObserver()
    const controller = new AbortController()
    const emit = vi.fn()
    if (when === 'before') {
      controller.abort()
    }
    const waiting = observer.observe(emit, controller.signal)
    controller.abort()
    await waiting
    expect(emit.mock.calls).toEqual(when === 'before' ? [[true]] : [[false], [true]])
  })

  it('reports an already retired lease without a ready acknowledgement', async () => {
    const observer = new RuntimePluginViewerLeaseObserver()
    observer.close()
    const emit = vi.fn()
    await observer.observe(emit, new AbortController().signal)
    expect(emit.mock.calls).toEqual([[true]])
  })

  it('releases its terminal listener when response delivery throws', async () => {
    const observer = new RuntimePluginViewerLeaseObserver()
    const emit = vi.fn(() => {
      throw new Error('transport gone')
    })
    await expect(observer.observe(emit, new AbortController().signal)).rejects.toThrow(
      'transport gone'
    )
    observer.close()
    expect(emit).toHaveBeenCalledOnce()
  })
})
