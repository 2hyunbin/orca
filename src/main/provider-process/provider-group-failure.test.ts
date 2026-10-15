import { PassThrough } from 'node:stream'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import type { ChildProcessHandle } from '@orca/process-host/process-spec'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { adoptProviderProcessGroup } from './provider-process-group'
import { watchProviderGroup } from './provider-group-watchdog'

vi.mock('@orca/process-host', () => ({ spawnProcess: vi.fn() }))

let watcher: ReturnType<typeof createFakePipedChild>
const kill = vi.spyOn(process, 'kill')

beforeEach(() => {
  watcher = Object.assign(createFakePipedChild(9000), { unref: vi.fn() })
  vi.useFakeTimers()
  vi.mocked(spawnProcess).mockReturnValue(watcher)
  kill.mockImplementation(() => true)
})
afterEach(() => {
  watcher.emit('exit', 1, null)
  vi.useRealTimers()
  vi.clearAllMocks()
})

afterAll(() => kill.mockRestore())

function provider(pid: number) {
  const child: ChildProcessHandle = createFakePipedChild(pid)
  child.stdio[3] = new PassThrough()
  return Object.assign(child, { spawnfile: '/bin/sh', exitCode: null, signalCode: null })
}

it('contains every active group before errors and never revives terminal failed cleanup', async () => {
  const first = provider(9101)
  const second = provider(9102)
  const a = adoptProviderProcessGroup(first)
  const b = adoptProviderProcessGroup(second)
  watcher.stdout.emit('data', '9101\n9102\n')
  const stopping = a?.stop()
  first.emit('exit', 0, null)
  const notified = vi.fn(() => {
    expect(kill).toHaveBeenCalledWith(-9101, 'SIGKILL')
    expect(kill).toHaveBeenCalledWith(-9102, 'SIGKILL')
  })
  first.on('error', notified)
  second.on('error', notified)
  watcher.emit('error', new Error('watcher failed'))
  expect(kill).toHaveBeenCalledWith(-9101, 'SIGKILL')
  expect(kill).toHaveBeenCalledWith(-9102, 'SIGKILL')
  await vi.advanceTimersByTimeAsync(4500)
  await expect(stopping).resolves.toBe(false)
  expect(notified).toHaveBeenCalledTimes(2)
  kill.mockClear()
  await expect(a?.stop()).resolves.toBe(false)
  await expect(b?.stop()).resolves.toBe(false)
  expect(kill).not.toHaveBeenCalled()
})

it('isolates a launch timeout, ignores late permission and keeps a replacement registration', async () => {
  const ready = vi.fn()
  const failed = vi.fn()
  const oldRelease = watchProviderGroup(9201, 'stop', ready, failed)
  watcher.stdout.emit('data', '9201\n')
  const replacementReady = vi.fn()
  const release = watchProviderGroup(9201, 'stop', replacementReady, failed)
  oldRelease()
  watcher.stdout.emit('data', '9201\n')
  const lateReady = vi.fn()
  const lateFailed = vi.fn()
  watchProviderGroup(9202, 'stop', lateReady, lateFailed)
  await vi.advanceTimersByTimeAsync(5000)
  watcher.stdout.emit('data', '9202\n')
  expect(ready).toHaveBeenCalledOnce()
  expect(replacementReady).toHaveBeenCalledOnce()
  expect(failed).not.toHaveBeenCalled()
  expect(lateFailed).toHaveBeenCalledOnce()
  expect(lateReady).not.toHaveBeenCalled()
  release()
})
