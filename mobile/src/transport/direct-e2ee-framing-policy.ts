import {
  hydrateE2EEV2HostLatch,
  isHostLatchedToE2EEV2,
  latchHostToE2EEV2
} from './e2ee-v2-host-latch'

export type DirectE2EEFraming = 'v2' | 'legacy'

export type DirectE2EEFramingPolicy = {
  framingForNextDial: () => DirectE2EEFraming
  noteV2Ready: () => void
  noteV2HelloRefused: () => void
}

export function createDirectE2EEFramingPolicy(hostPublicKeyB64: string): DirectE2EEFramingPolicy {
  void hydrateE2EEV2HostLatch()
  let helloRefused = false
  return {
    // Why: only a host never seen speaking v2 that refused a v2 hello predates
    // direct v2; anything else falling back would be a downgrade.
    framingForNextDial: () =>
      helloRefused && isHostLatchedToE2EEV2(hostPublicKeyB64) === false ? 'legacy' : 'v2',
    noteV2Ready: () => {
      helloRefused = false
      latchHostToE2EEV2(hostPublicKeyB64)
    },
    noteV2HelloRefused: () => {
      helloRefused = true
    }
  }
}
