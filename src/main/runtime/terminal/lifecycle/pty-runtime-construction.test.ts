import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { OrcaRuntimeService } from '../../orca-runtime'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false },
  BrowserWindow: { fromId: () => null },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: () => null }
}))

const PTY_ID = 'pty-constructor-probe'

describe('PTY methods during runtime construction', () => {
  it('keeps registration fences and liveness on the original canonical state', async () => {
    const pending: Promise<unknown>[] = []
    let seamCalls = 0
    class ConstructorRuntime extends OrcaRuntimeService {
      protected get canonicalFetchKeyCache(): ReadonlyMap<string, string> {
        seamCalls++
        this.beginPtyRegistration(PTY_ID, 'incarnation')
        expect(this.pendingPtyRegistrationIncarnations.get(PTY_ID)).toBe('incarnation')
        this.cancelPendingPtyRegistration(PTY_ID, 'incarnation')
        expect(this.pendingPtyRegistrationIncarnations.has(PTY_ID)).toBe(false)
        this.assertPtyRegistrationAllowed(PTY_ID, 'incarnation')
        this.releaseRejectedPtyRegistrationFence(PTY_ID, 'incarnation')
        this.acceptPtyIncarnationForExit(PTY_ID, 'incarnation')
        this.markPtyStopRequested(PTY_ID)
        expect(this.isPtyStopRequested(PTY_ID)).toBe(true)
        this.markPtyLivenessLive(PTY_ID)
        expect(this.getPtyLivenessVerdict(PTY_ID)).toEqual({ status: 'live', ptyIds: [PTY_ID] })
        this.markPtyLivenessUnverifiable(PTY_ID, 'host unavailable')
        expect(this.getPtyLivenessVerdict(PTY_ID)).toEqual({
          status: 'unverifiable',
          reason: 'host unavailable'
        })
        this.forgetPtyLivenessVerdict(PTY_ID)
        expect(this.getPtyLivenessVerdict(PTY_ID)).toBeNull()
        expect(this.getTerminalPtyIdForHandle('missing')).toBeNull()
        expect(this.getAgentProviderSessionRows()).toEqual([])
        expect(this.getAgentStatusRowsForPane('missing')).toEqual([])
        pending.push(
          this.confirmTerminalShellAlone(PTY_ID).then((value) => expect(value).toBe(false))
        )
        pending.push(
          this.refreshPtyWorktreeRecordsFromController([]).then((value) => expect(value).toBeNull())
        )
        pending.push(
          this.refreshPtyWorktreeRecordsWithControllerInventory([]).then((value) =>
            expect(value).toBeNull()
          )
        )
        this.invalidatePtyControllerInventoryForLifecycle(PTY_ID)
        expect(this.ptyControllerInventorySequence).toBe(1)
        return super.canonicalFetchKeyCache
      }
    }
    expect(() => new ConstructorRuntime(null)).not.toThrow()
    expect(seamCalls).toBe(1)
    await Promise.all(pending)
  })
})
