import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as watcher from '@parcel/watcher'
import { afterEach, describe, expect, it, vi } from 'vitest'

const DELIVERY_TIMEOUT_MS = 8_000

describe.runIf(process.platform === 'darwin')('patched watcher FSEvents latency', () => {
  let root: string | null = null
  const subscriptions: watcher.AsyncSubscription[] = []

  afterEach(async () => {
    await Promise.all(subscriptions.splice(0).map((subscription) => subscription.unsubscribe()))
    if (root) {
      await rm(root, { recursive: true, force: true })
      root = null
    }
  })

  it('loads the source build, which honors latency', () => {
    expect(watcher.supportsLatency).toBe(true)
  })

  it('holds delivery for the requested latency on a separate stream per latency', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-watch-latency-')))
    const watchRoot = root
    const file = join(watchRoot, 'edit.ts')
    const seenAt = new Map<number, number>()
    for (const latency of [0.001, 0.6]) {
      subscriptions.push(
        await watcher.subscribe(
          watchRoot,
          (error, events) => {
            if (!error && !seenAt.has(latency) && events.some((event) => event.path === file)) {
              seenAt.set(latency, Date.now())
            }
          },
          { latency }
        )
      )
    }

    const writtenAt = Date.now()
    await writeFile(file, 'source')
    await vi.waitFor(() => expect(seenAt.size).toBe(2), {
      timeout: DELIVERY_TIMEOUT_MS,
      interval: 50
    })

    // A lower bound only: FSEvents never delivers before the latency, but load can always add more.
    expect(seenAt.get(0.6)! - writtenAt).toBeGreaterThanOrEqual(500)
    expect(seenAt.get(0.001)!).toBeLessThanOrEqual(seenAt.get(0.6)!)
  })
})
