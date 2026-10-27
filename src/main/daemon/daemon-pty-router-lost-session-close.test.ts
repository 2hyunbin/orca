// A WSL bridge pane lost with its distro keeps its tab and unended history; after a relaunch no
// daemon runs its id, so closing the tab must still end that history, and only then.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import type { DaemonServer } from './daemon-server'
import { getHistorySessionDirName } from './history-paths'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'

describe('closing a kept host-loss tab after a relaunch', () => {
  let dir: string
  let historyDir: string
  let server: DaemonServer
  let socketPath: string
  let tokenPath: string
  let lostId: string
  const opened: DaemonPtyAdapter[] = []

  beforeEach(async () => {
    historyDir = mkdtempSync(join(tmpdir(), 'orca-lost-close-history-'))
    let subprocess: ReturnType<typeof createMockSubprocess> | undefined
    const harness = await startDaemonAdapterHarness(
      () => {
        subprocess = createMockSubprocess()
        return subprocess
      },
      {
        readRunningWslDistros: async () => ({ status: 'confirmed', distros: [] }),
        historyPath: historyDir
      }
    )
    ;({ dir, server, socketPath, tokenPath } = harness)
    opened.push(harness.adapter)
    const exited: string[] = []
    harness.adapter.onExit(({ id }) => exited.push(id))
    lostId = (await harness.adapter.spawn({ cols: 80, rows: 24 })).id
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the adapter's protected map, which a WSL spawn fills; set here without faking win32.
    const internals = harness.adapter as unknown as { wslDistrosBySessionId: Map<string, string> }
    internals.wslDistrosBySessionId.set(lostId, 'Ubuntu')
    subprocess!._simulateExit(1)
    await waitFor(() => exited.length > 0)
    // The relaunched app's adapters (below) remember nothing of the loss.
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const adapter of opened.splice(0)) {
      adapter.dispose()
    }
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
    rmSync(historyDir, { recursive: true, force: true })
  })

  function relaunchedRouter(legacyListing?: boolean | null): DaemonPtyRouter {
    const current = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
    opened.push(current)
    const legacy: DaemonPtyAdapter[] = []
    if (legacyListing !== undefined) {
      const older = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
      vi.spyOn(older, 'listsSession').mockResolvedValue(legacyListing)
      opened.push(older)
      legacy.push(older)
    }
    return new DaemonPtyRouter({ current, legacy })
  }

  const historyKept = () => existsSync(join(historyDir, getHistorySessionDirName(lostId)))

  it('starts from history left unended, as a cold restore needs', () => {
    const reader = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
    opened.push(reader)
    expect(reader.hasRestorableHistory(lostId)).toBe(true)
  })

  it('ends the history of a session no daemon lists', async () => {
    expect(historyKept()).toBe(true)
    await expect(relaunchedRouter().shutdown(lostId, { immediate: true })).resolves.toBeUndefined()
    expect(historyKept()).toBe(false)
  })

  it('keeps the history while another daemon still lists the id', async () => {
    await expect(relaunchedRouter(true).shutdown(lostId, { immediate: true })).rejects.toThrow(
      'Session not found'
    )
    expect(historyKept()).toBe(true)
  })

  it('keeps the history when a daemon cannot say', async () => {
    await expect(relaunchedRouter(null).shutdown(lostId, { immediate: true })).rejects.toThrow(
      'Session not found'
    )
    expect(historyKept()).toBe(true)
  })

  it('keeps the history of a session that ended on its own', async () => {
    await expect(
      relaunchedRouter().shutdown('never-restorable', { immediate: true })
    ).rejects.toThrow('Session not found')
  })
})
