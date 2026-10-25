import { describe, expect, it } from 'vitest'
import { withPlatform } from './orca-runtime-test-fixtures.spec'
import { createHydrationRuntime, PTY_ID } from './headless-hydration-ownership-test-fixture'

const HISTORY = Array.from({ length: 60 }, (_, i) => `H${i}`).join('\r\n')

async function scrollbackAfterShrinkAndGrow(platform: NodeJS.Platform): Promise<number> {
  return withPlatform(platform, async () => {
    const runtime = createHydrationRuntime()
    runtime.onPtyData(PTY_ID, HISTORY, 1)
    const model = runtime.model()
    await model.writeChain
    const before = model.emulator.getSnapshot().scrollbackLines
    model.emulator.resize(80, 2)
    model.emulator.resize(80, 24)
    return model.emulator.getSnapshot().scrollbackLines - before
  })
}

// awin verify-14: ConPTY repaints its own grid after a resize, so rows pulled back from history
// into main's copy were overwritten before a reveal repainted the window from it.
describe("main's copy of a local pane", () => {
  it("grows rows the ConPTY way on Windows, keeping history out of ConPTY's grid", async () => {
    expect(await scrollbackAfterShrinkAndGrow('win32')).toBeGreaterThan(0)
  })

  it('keeps the Unix grow model elsewhere', async () => {
    expect(await scrollbackAfterShrinkAndGrow('darwin')).toBeLessThanOrEqual(0)
  })
})
