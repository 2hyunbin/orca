import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { stopRendererOwnedPty, type PtyKillIpcDeps } from '../ipc/renderer-kill'
import { finishPtyShutdown } from '../provider/liveness'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { getLocalPtyProvider, setLocalPtyProvider } from '../provider/registry'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { killPtyFromRuntimeController, stopAndWaitPtyFromRuntimeController } from './kill'

const PTY_ID = 'respawned-pty'

// The shutdown of the first incarnation acknowledges only after a respawn took the id.
function respawningProvider(): IPtyProvider {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stops call only shutdown and listProcesses.
  return {
    shutdown: async () => {
      ptyOwnership.set(PTY_ID, LOCAL_EXECUTION_HOST_ID)
      ptyIncarnationById.set(PTY_ID, 'inc-respawn')
    },
    listProcesses: async () => []
  } as unknown as IPtyProvider
}

function harness() {
  const runtime = {
    markPtyStopRequested: vi.fn(),
    markPtyLivenessUnverifiable: vi.fn(),
    markPtyLivenessLive: vi.fn(),
    onPtyExit: vi.fn()
  }
  const ports = {
    runtime,
    getLocalPtyProviderStartupPromise: () => undefined,
    shutdownProviderAndDetectExit: async (provider: IPtyProvider, id: string) => {
      await provider.shutdown(id, { immediate: true })
      return false
    },
    rememberSyntheticKillExit: vi.fn(),
    sendPtyExitToRenderer: vi.fn(),
    finishPtyShutdown,
    retiredRejectedPtyIds: new Map<string, NodeJS.Timeout>()
  }
  return { runtime, ports }
}

describe('a stop whose shutdown lands after a same-id respawn', () => {
  const original = getLocalPtyProvider()
  beforeEach(() => {
    setLocalPtyProvider(respawningProvider())
    ptyOwnership.set(PTY_ID, LOCAL_EXECUTION_HOST_ID)
    ptyIncarnationById.set(PTY_ID, 'inc-stopped')
  })
  afterEach(() => {
    setLocalPtyProvider(original)
    ptyOwnership.delete(PTY_ID)
    ptyIncarnationById.delete(PTY_ID)
  })

  function expectRespawnUntouched({ runtime, ports }: ReturnType<typeof harness>): void {
    expect(ptyOwnership.get(PTY_ID)).toBe(LOCAL_EXECUTION_HOST_ID)
    expect(ptyIncarnationById.get(PTY_ID)).toBe('inc-respawn')
    expect(runtime.onPtyExit).not.toHaveBeenCalled()
    expect(ports.sendPtyExitToRenderer).not.toHaveBeenCalled()
  }

  it('leaves the respawn alone after a runtime kill', async () => {
    const h = harness()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: kill reads only these ports and an optional store.
    killPtyFromRuntimeController(h.ports as unknown as PtyRuntimeControllerDeps, PTY_ID)
    await vi.waitFor(() => expect(ptyIncarnationById.get(PTY_ID)).toBe('inc-respawn'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expectRespawnUntouched(h)
  })

  it('leaves the respawn alone after a stop-and-wait', async () => {
    const h = harness()
    await stopAndWaitPtyFromRuntimeController(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: stop-and-wait reads only these ports and an optional store.
      h.ports as unknown as PtyRuntimeControllerDeps,
      PTY_ID
    )
    expectRespawnUntouched(h)
  })

  it('leaves the respawn alone after a renderer tab close', async () => {
    const h = harness()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tab-close stop reads only these ports and an optional store.
    await stopRendererOwnedPty(h.ports as unknown as PtyKillIpcDeps, { id: PTY_ID })
    expectRespawnUntouched(h)
  })
})
