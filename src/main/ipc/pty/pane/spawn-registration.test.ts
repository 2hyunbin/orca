import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPtyProvider, PtySpawnResult } from '../../../providers/pty-provider-contract'
import { ptyIncarnationById, ptyOwnership, setPtyOwnership } from '../provider/ownership-state'
import { discardUnpersistedPtySpawn } from './spawn-registration'

const PTY_ID = 'ssh-unpersisted'
const result: PtySpawnResult = { id: PTY_ID, incarnationId: 'inc-1' }

function providerWhoseShutdown(shutdown: () => Promise<void>): IPtyProvider {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: discard calls only shutdown.
  return { shutdown } as unknown as IPtyProvider
}

describe('discarding a spawn whose binding failed to save', () => {
  afterEach(() => {
    ptyOwnership.delete(PTY_ID)
    ptyIncarnationById.delete(PTY_ID)
  })

  function spawned(): void {
    setPtyOwnership(PTY_ID, 'ssh:conn-1')
    ptyIncarnationById.set(PTY_ID, 'inc-1')
  }

  it('keeps ownership and reads unverifiable when the shutdown fails', async () => {
    spawned()
    const runtime = { markPtyLivenessUnverifiable: vi.fn() }
    const provider = providerWhoseShutdown(() => Promise.reject(new Error('relay timed out')))

    await discardUnpersistedPtySpawn(provider, result, runtime)

    expect(ptyOwnership.get(PTY_ID)).toBe('ssh:conn-1')
    expect(runtime.markPtyLivenessUnverifiable).toHaveBeenCalledWith(
      PTY_ID,
      expect.stringContaining('relay timed out')
    )
  })

  it('retires ownership once the host acknowledged the shutdown', async () => {
    spawned()
    const runtime = { markPtyLivenessUnverifiable: vi.fn() }

    await discardUnpersistedPtySpawn(
      providerWhoseShutdown(() => Promise.resolve()),
      result,
      runtime
    )

    expect(ptyOwnership.has(PTY_ID)).toBe(false)
    expect(runtime.markPtyLivenessUnverifiable).not.toHaveBeenCalled()
  })

  it('leaves a same-id replacement that arrived during the shutdown alone', async () => {
    spawned()
    const provider = providerWhoseShutdown(async () => {
      ptyIncarnationById.set(PTY_ID, 'inc-2')
    })

    await discardUnpersistedPtySpawn(provider, result, undefined)

    expect(ptyOwnership.get(PTY_ID)).toBe('ssh:conn-1')
    expect(ptyIncarnationById.get(PTY_ID)).toBe('inc-2')
  })

  it('keeps an exit observed during a shutdown whose reply was lost', async () => {
    spawned()
    const runtime = { markPtyLivenessUnverifiable: vi.fn() }
    const provider = providerWhoseShutdown(async () => {
      // The provider's exit listener retires the PTY before the RPC rejects.
      ptyOwnership.delete(PTY_ID)
      ptyIncarnationById.delete(PTY_ID)
      throw new Error('shutdown response lost')
    })

    await discardUnpersistedPtySpawn(provider, result, runtime)

    expect(runtime.markPtyLivenessUnverifiable).not.toHaveBeenCalled()
  })

  it('does not mark a same-id replacement unverifiable when the predecessor shutdown fails', async () => {
    spawned()
    const runtime = { markPtyLivenessUnverifiable: vi.fn() }
    const provider = providerWhoseShutdown(async () => {
      ptyIncarnationById.set(PTY_ID, 'inc-2')
      throw new Error('shutdown response lost')
    })

    await discardUnpersistedPtySpawn(provider, result, runtime)

    expect(ptyIncarnationById.get(PTY_ID)).toBe('inc-2')
    expect(runtime.markPtyLivenessUnverifiable).not.toHaveBeenCalled()
  })
})
