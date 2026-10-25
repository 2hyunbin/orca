import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { readRuntimeFixture, readTimedRuntimeFixture } from './agent-transcript-replay-test-harness'
import { waitForWorkerStartComposer } from './launched-agent-composer-readiness'
import { RuntimeMachineName } from './runtime-machine-name'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const NO_TITLE_BOOT = 'claude-2-1-310-timed-boot-no-title'

describe('a Claude worker start with its terminal title turned off', () => {
  beforeEach(() => {
    vi.spyOn(RuntimeMachineName.prototype, 'start').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('is ready on its composer, which is the only signal it draws', async () => {
    const { chunks, times } = readTimedRuntimeFixture(NO_TITLE_BOOT)
    // Presence precondition: no OSC title, so tui-idle alone never settles (#22655).
    expect(chunks.join('')).not.toContain('\x1b]0;')
    const composerAt = times[chunks.findIndex((chunk) => chunk.includes('❯ '))]
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Terminal',
      foregroundProcess: 'claude',
      launchAgent: 'claude',
      size: { cols: 120, rows: 40 },
      data: ''
    })
    vi.useFakeTimers()
    const startedAt = Date.now()
    let settledAt: number | null = null
    void waitForWorkerStartComposer(runtime, handle, 'claude', 20_000).then(
      (wait) => {
        settledAt = wait.satisfied ? Date.now() - startedAt : null
      },
      () => {}
    )
    for (const [index, chunk] of chunks.entries()) {
      await vi.advanceTimersByTimeAsync(Math.max(0, startedAt + times[index] - Date.now()))
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, chunk, Date.now())
    }
    await vi.advanceTimersByTimeAsync(5_000)
    expect(settledAt).not.toBeNull()
    expect(settledAt).toBeGreaterThanOrEqual(composerAt)
    expect(settledAt).toBeLessThan(composerAt + 1_000)
  })
})

describe('the Claude composer marker', () => {
  const firesOn = (fixture: string): boolean => {
    const scanner = createDraftPasteReadyScanner('claude-composer-prompt')
    return scanner.observe(readRuntimeFixture(fixture)).ready
  }

  it('does not fire on the workspace-trust menu, which draws the same pointer', () => {
    expect(readRuntimeFixture('claude-dialog-trust-workspace')).toContain('❯')
    expect(firesOn('claude-dialog-trust-workspace')).toBe(false)
  })

  it('fires once that menu is answered and the composer mounts', () => {
    expect(firesOn('claude-dialog-trust-workspace-answered')).toBe(true)
  })
})
