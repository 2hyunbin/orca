import { expect, it, vi } from 'vitest'
import { waitForPromiseWithSignal } from './abort-signal-reason'

it('observes work that rejects after its caller has already canceled', async () => {
  const controller = new AbortController()
  const reason = new Error('Caller canceled')
  controller.abort(reason)
  const work = new Promise<never>((_resolve, reject) => {
    queueMicrotask(() => reject(new Error('Late filesystem failure')))
  })

  await expect(waitForPromiseWithSignal(work, controller.signal)).rejects.toBe(reason)
  await new Promise<void>((resolve) => setImmediate(resolve))
})

it.each(['before', 'during'])('can replace private abort reasons %s waiting', async (when) => {
  const controller = new AbortController()
  const privateReason = new Error('private caller context')
  const safeReason = new Error('Operation canceled')
  const work = Promise.withResolvers<void>()
  if (when === 'before') {
    controller.abort(privateReason)
  }
  const pending = waitForPromiseWithSignal(work.promise, controller.signal, () => safeReason)
  controller.abort(privateReason)
  await expect(pending).rejects.toBe(safeReason)
  work.reject(new Error('late failure'))
  await new Promise<void>((resolve) => setImmediate(resolve))
})

it('cleans the listener once and preserves an operation failure', async () => {
  const controller = new AbortController()
  const remove = vi.spyOn(controller.signal, 'removeEventListener')
  const failure = new Error('operation failed')
  await expect(waitForPromiseWithSignal(Promise.reject(failure), controller.signal)).rejects.toBe(
    failure
  )
  controller.abort()
  expect(remove).toHaveBeenCalledOnce()
})
