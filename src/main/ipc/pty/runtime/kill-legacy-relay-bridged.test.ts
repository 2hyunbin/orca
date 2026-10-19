import { describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { SshRemotePtyLease } from '../../../../shared/ssh-types'
import {
  closeLegacyRelayPane,
  installLegacyRelayBridge
} from '../../../ssh/legacy-relay/legacy-relay-bridge-registry'
import { stopRendererOwnedPty, type PtyKillIpcDeps } from '../ipc/renderer-kill'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { killPtyFromRuntimeController } from './kill'

const TARGET = 'ssh-box'
const lease: SshRemotePtyLease = {
  targetId: TARGET,
  ptyId: 'pty2:epoch:1',
  tabId: 'tab-1',
  state: 'detached',
  createdAt: 1,
  updatedAt: 1
}

describe('a generic kill of a terminal an older relay still runs', () => {
  it('leaves its lease to the bridge instead of tombstoning a shell it never stopped', () => {
    const retireLease = vi.fn()
    installLegacyRelayBridge({
      leases: () => [lease],
      retireLease,
      recordStop: vi.fn(),
      // Disconnected: the bridge can only record the stop for the next connect.
      connection: () => null,
      onPanesChanged: () => {},
      onData: () => {},
      onReplay: () => {},
      onExit: () => {},
      report: () => {}
    })
    const finishPtyShutdown = vi.fn()
    const deps = {
      runtime: null,
      store: null,
      getLocalPtyProviderStartupPromise: () => null,
      shutdownProviderAndDetectExit: vi.fn(),
      finishPtyShutdown,
      retiredRejectedPtyIds: new Set<string>()
    }
    const accepted = killPtyFromRuntimeController(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridged branch returns before reading any other dep.
      deps as unknown as PtyRuntimeControllerDeps,
      toAppSshPtyId(TARGET, lease.ptyId)
    )
    expect(accepted).toBe(true)
    expect(finishPtyShutdown).not.toHaveBeenCalled()
    expect(deps.shutdownProviderAndDetectExit).not.toHaveBeenCalled()
    expect(retireLease).not.toHaveBeenCalled()
    installLegacyRelayBridge(null)
  })
})

describe('a tab close of a terminal an older relay still runs', () => {
  it('hands the stop to the bridge instead of tombstoning the lease the bridge needs', async () => {
    const leases: SshRemotePtyLease[] = [{ ...lease }]
    const store = {
      markSshRemotePtyLease: vi.fn((_target: string, relayPtyId: string) => {
        for (const row of leases) {
          if (row.ptyId === relayPtyId) {
            row.state = 'terminated'
          }
        }
      })
    }
    installLegacyRelayBridge({
      leases: () => leases,
      retireLease: vi.fn(),
      recordStop: vi.fn(),
      // Disconnected, so the SSH provider is unregistered: the bridge records the stop.
      connection: () => null,
      onPanesChanged: () => {},
      onData: () => {},
      onReplay: () => {},
      onExit: () => {},
      report: () => {}
    })
    const ptyId = toAppSshPtyId(TARGET, lease.ptyId)
    const deps = {
      store,
      getLocalPtyProviderStartupPromise: () => undefined,
      shutdownProviderAndDetectExit: vi.fn(),
      rememberSyntheticKillExit: vi.fn(),
      sendPtyExitToRenderer: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridged branch reads only these deps.
    await stopRendererOwnedPty(deps as unknown as PtyKillIpcDeps, { id: ptyId })
    expect(store.markSshRemotePtyLease).not.toHaveBeenCalled()
    expect(deps.shutdownProviderAndDetectExit).not.toHaveBeenCalled()
    // The transport's own close that follows still reaches a pending stop, not `not-bridged`.
    await expect(closeLegacyRelayPane(ptyId)).resolves.toEqual({ status: 'unverifiable' })
    installLegacyRelayBridge(null)
  })
})
