import type { Page } from 'playwright'
import { expect } from 'vitest'
import { startHiddenRendererFrameCapture } from './hidden-renderer-frame-capture-fixture'

// DIAGNOSTIC(popup-flake): temporary timing probe, removed before merge.
function rafRate(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let count = 0
        const end = performance.now() + 500
        const tick = (): void => {
          count++
          if (performance.now() < end) {
            requestAnimationFrame(tick)
          } else {
            resolve(count)
          }
        }
        requestAnimationFrame(tick)
        setTimeout(() => resolve(count), 3000)
      })
  )
}

export async function startDiagnosedFrameCapture(page: Page): Promise<() => Promise<void>> {
  const name = page.url().split('/').pop()
  const pre = await rafRate(page)
  const t0 = Date.now()
  let doubleRaf = -1
  return startHiddenRendererFrameCapture(page, async (hasFrame) => {
    const rafDone = page
      .evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      .then(() => (doubleRaf = Date.now() - t0))
    const post = rafRate(page)
    await expect.poll(hasFrame, { timeout: 30_000 }).toBe(true)
    const firstFrame = Date.now() - t0
    await rafDone
    process.stdout.write(
      `[popup-flake-diag] page=${name} preRaf500=${pre} firstFrame=${firstFrame} doubleRaf=${doubleRaf} postRaf500=${await post}\n`
    )
  })
}
