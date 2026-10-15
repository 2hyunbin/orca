import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyPeerReplacements,
  replacedRuntimeEnvironmentIds,
  resetDeferredPeerChecksForTests
} from './runtime-environment-peer-replacement'

afterEach(() => resetDeferredPeerChecksForTests())

function managed(
  overrides: { generation?: number; pairingRevision?: number; hostKey?: string | null; wsl?: boolean } = {}
) {
  return {
    id: 'env-1',
    createdAt: 1,
    pairingRevision: overrides.pairingRevision ?? 1,
    ...(overrides.hostKey === null ? {} : { hostKeyFingerprint: overrides.hostKey ?? 'key-a' }),
    orcadDeployment: overrides.wsl ? {
      kind: 'wsl' as const,
      distro: 'Ubuntu',
      distroId: '0e3a7f2c-1b4d-4c5e-9f60-7a8b9c0d1e2f',
      localPort: 46_768,
      remotePort: 6_768
    } : {
      sshTargetId: 'box',
      sshTargetGeneration: overrides.generation ?? 1,
      localPort: 46_768,
      remotePort: 6_768
    }
  }
}

function retired(previous: ReturnType<typeof managed>, next: ReturnType<typeof managed>): string[] {
  return classifyPeerReplacements(
    [previous],
    [next],
    replacedRuntimeEnvironmentIds([previous], [next])
  ).retired
}

describe('which re-paired environments name a different machine', () => {
  it.each([false, true])(
    'keeps open work when a managed server re-pairs with the same proven host key (WSL: %s)',
    (wsl) => {
      expect(retired(managed({ wsl }), managed({ wsl, pairingRevision: 2 }))).toEqual([])
    }
  )

  it('retires the same target registration when the host proves a different key', () => {
    expect(retired(managed(), managed({ pairingRevision: 2, hostKey: 'key-reinstalled' }))).toEqual(
      ['env-1']
    )
  })

  it('defers a re-pair whose host key is not known yet instead of retiring it', () => {
    expect(retired(managed(), managed({ pairingRevision: 2, hostKey: null }))).toEqual([])
    expect(
      classifyPeerReplacements(
        [managed({ pairingRevision: 2, hostKey: null })],
        [managed({ pairingRevision: 2, hostKey: 'key-b' })],
        []
      ).retired
    ).toEqual(['env-1'])
  })

  it('retires a managed server re-created for a new host registration', () => {
    expect(retired(managed(), managed({ generation: 2, pairingRevision: 2 }))).toEqual(['env-1'])
  })

  it('retires a re-paired environment that is not a managed server', () => {
    const paired = { id: 'env-1', createdAt: 1, pairingRevision: 1, hostKeyFingerprint: 'k' }
    expect(
      classifyPeerReplacements([paired], [{ ...paired, pairingRevision: 2 }], ['env-1']).retired
    ).toEqual(['env-1'])
  })

  it('leaves an environment alone while its pairing is unchanged', () => {
    expect(replacedRuntimeEnvironmentIds([managed()], [managed()])).toEqual([])
  })
})

describe('which re-pairs a live pane may follow', () => {
  const classify = (previous: ReturnType<typeof managed>, next: ReturnType<typeof managed>) =>
    classifyPeerReplacements([previous], [next], replacedRuntimeEnvironmentIds([previous], [next]))

  it('reports a same-key update as a same-host rotation from the old pairing', () => {
    expect(classify(managed(), managed({ pairingRevision: 2 }))).toEqual({
      retired: [],
      sameHost: [{ id: 'env-1', fromRevision: 1, toRevision: 2 }]
    })
  })

  it('never reports a changed key or a new registration as a same-host rotation', () => {
    expect(classify(managed(), managed({ pairingRevision: 2, hostKey: 'key-b' })).sameHost).toEqual(
      []
    )
    expect(classify(managed(), managed({ generation: 2, pairingRevision: 2 })).sameHost).toEqual([])
  })

  it('reports a deferred re-pair only once its key proves the same host, from the original pairing', () => {
    expect(classify(managed(), managed({ pairingRevision: 2, hostKey: null }))).toEqual({
      retired: [],
      sameHost: []
    })
    expect(
      classifyPeerReplacements(
        [managed({ pairingRevision: 2, hostKey: null })],
        [managed({ pairingRevision: 2 })],
        []
      )
    ).toEqual({ retired: [], sameHost: [{ id: 'env-1', fromRevision: 1, toRevision: 2 }] })
  })
})
