// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import type { PairingTicketOffer } from '../../../shared/pairing-ticket-offer'
import { createMemoryWebDeviceKeyStore, webDeviceKeyId } from './web-device-key-store'
import { createStoredWebRuntimeEnvironment } from './web-runtime-environment'
import { setWebDeviceKeySupportForTests } from './web-device-key-support'
import { createWebRuntimeUnauthorizedError } from './web-runtime-client-error'
import type { WebRuntimeCredentialSource } from './web-runtime-credential-source'
import {
  pairWebBrowserWithTicket,
  webBrowserDeviceLabel,
  type WebTicketPairingDeps
} from './web-pairing-ticket-redemption'

const offer: PairingTicketOffer = {
  v: 3,
  endpoint: 'wss://studio.example:6768',
  publicKeyB64: Buffer.alloc(32, 4).toString('base64'),
  ticket: Buffer.alloc(32, 9).toString('base64url'),
  deviceId: '1b1f6d1e-6d5f-4b0e-9a49-4c1d2d0f8a11',
  scope: 'runtime',
  expiresAt: 1_800_000_000_000
}

function deps(
  support: WebTicketPairingDeps['support'],
  outcome: 'ok' | 'denied' = 'ok'
): { deps: WebTicketPairingDeps; seen: { credential?: WebRuntimeCredentialSource } } {
  const seen: { credential?: WebRuntimeCredentialSource } = {}
  return {
    seen,
    deps: {
      support,
      store: createMemoryWebDeviceKeyStore(),
      subtle: globalThis.crypto.subtle,
      deviceLabel: 'Chrome on macOS',
      rememberSessionDevice: vi.fn(),
      saveEnvironment: vi.fn(),
      createClient: (_connection, options) => {
        seen.credential = options.credential
        options.onPairingComparisonCode('KMGVTD')
        return {
          call: async () => {
            if (outcome === 'denied') {
              throw createWebRuntimeUnauthorizedError('approval-denied')
            }
            return { id: 'r', ok: true, result: {}, _meta: { runtimeId: 'runtime-1' } }
          },
          close: vi.fn()
        }
      }
    }
  }
}

afterEach(() => setWebDeviceKeySupportForTests(null))

describe('pairing a browser with a ticket', () => {
  it('redeems with a non-extractable key and stores no token, only a placeholder', async () => {
    setWebDeviceKeySupportForTests('persistent')
    const { deps: pairing, seen } = deps('persistent')
    const onComparisonCode = vi.fn()
    const environment = await pairWebBrowserWithTicket({
      offer,
      name: 'Studio',
      previousEnvironment: null,
      onComparisonCode,
      deps: pairing
    })
    expect(onComparisonCode).toHaveBeenCalledWith('KMGVTD')
    expect(seen.credential).toBeDefined()
    expect(JSON.stringify(environment)).not.toContain(offer.ticket)
    expect(environment.endpoints[0]?.deviceToken).toBe(`migrated:${offer.deviceId}`)
    expect(environment.pairedDeviceId).toBe(offer.deviceId)
    const record = await pairing.store.get(webDeviceKeyId(offer.publicKeyB64, environment.id))
    expect(record).toMatchObject({ state: 'active', deviceId: offer.deviceId })
    expect(record?.privateKey.extractable).toBe(false)
  })

  it('keeps a session-only browser key in memory and asks for an ephemeral row', async () => {
    setWebDeviceKeySupportForTests('session-insecure-origin')
    const { deps: pairing, seen } = deps('session-insecure-origin')
    const firstPlans: unknown[] = []
    const createClient = pairing.createClient
    pairing.createClient = (connection, options) => {
      firstPlans.push(options.credential.nextPlan(true))
      return createClient(connection, options)
    }
    const environment = await pairWebBrowserWithTicket({
      offer,
      name: 'Studio',
      previousEnvironment: null,
      onComparisonCode: vi.fn(),
      deps: pairing
    })
    expect(firstPlans[0]).toMatchObject({
      kind: 'redeem',
      ephemeral: true,
      deviceLabel: 'Chrome on macOS'
    })
    expect(environment.sessionOnly).toBe(true)
    expect(pairing.rememberSessionDevice).toHaveBeenCalledWith(
      expect.objectContaining({ id: environment.id }),
      expect.objectContaining({ deviceId: offer.deviceId })
    )
    expect(seen.credential).toBeDefined()
  })

  it('drops the pending key when the host refuses the ticket', async () => {
    setWebDeviceKeySupportForTests('persistent')
    const { deps: pairing } = deps('persistent', 'denied')
    const createdIds: string[] = []
    const add = pairing.store.add
    pairing.store.add = async (record) => {
      createdIds.push(record.id)
      return add(record)
    }
    await expect(
      pairWebBrowserWithTicket({
        offer,
        name: 'Studio',
        previousEnvironment: null,
        onComparisonCode: vi.fn(),
        deps: pairing
      })
    ).rejects.toThrow(/declined this pairing/)
    expect(createdIds).toHaveLength(1)
    expect(await pairing.store.get(createdIds[0]!)).toBeUndefined()
  })

  it('labels the browser without identifying details', () => {
    expect(
      webBrowserDeviceLabel(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36'
      )
    ).toBe('Chrome on macOS')
    expect(
      webBrowserDeviceLabel(
        'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0'
      )
    ).toBe('Firefox on Linux')
    expect(webBrowserDeviceLabel('curl/8')).toBe('Web browser')
  })

  describe('re-pairing a browser already paired with the same host', () => {
    async function pairedBefore(pairing: WebTicketPairingDeps) {
      const previous = createStoredWebRuntimeEnvironment({
        name: 'Studio',
        offer: {
          v: 2,
          endpoint: offer.endpoint,
          deviceToken: 'migrated:old-device',
          publicKeyB64: offer.publicKeyB64,
          scope: 'runtime'
        }
      })
      const keys = await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
        'sign',
        'verify'
      ])
      if (!('privateKey' in keys)) {
        throw new Error('expected a key pair')
      }
      const active = {
        id: webDeviceKeyId(offer.publicKeyB64, previous.id),
        privateKey: keys.privateKey,
        publicKeyB64: 'old-public-key',
        state: 'active' as const,
        deviceId: 'old-device',
        pairingRevision: previous.createdAt
      }
      await pairing.store.put(active)
      return { previous, active }
    }

    it('keeps the working key when the host refuses the new ticket', async () => {
      setWebDeviceKeySupportForTests('persistent')
      const { deps: pairing, seen } = deps('persistent', 'denied')
      const { previous, active } = await pairedBefore(pairing)
      await expect(
        pairWebBrowserWithTicket({
          offer,
          name: 'Studio',
          previousEnvironment: previous,
          onComparisonCode: vi.fn(),
          deps: pairing
        })
      ).rejects.toThrow(/declined this pairing/)
      expect(await pairing.store.get(active.id)).toEqual(active)
      const sent = seen.credential?.nextPlan(true)
      expect(sent).toMatchObject({ kind: 'redeem' })
      expect(sent).not.toMatchObject({ key: { publicKeyB64: 'old-public-key' } })
    })

    it('replaces the old key only after the host confirmed the new one', async () => {
      setWebDeviceKeySupportForTests('persistent')
      const { deps: pairing } = deps('persistent')
      const { previous, active } = await pairedBefore(pairing)
      const environment = await pairWebBrowserWithTicket({
        offer,
        name: 'Studio',
        previousEnvironment: previous,
        onComparisonCode: vi.fn(),
        deps: pairing
      })
      expect(environment.id).toBe(previous.id)
      const record = await pairing.store.get(active.id)
      expect(record).toMatchObject({ state: 'active', deviceId: offer.deviceId })
      expect(record?.publicKeyB64).not.toBe('old-public-key')
      expect(record?.pairingRevision).toBe(environment.pairingRevision)
    })
  })

  it('saves the new pairing before its key replaces the old one, so a crash keeps a usable key', async () => {
    setWebDeviceKeySupportForTests('persistent')
    const { deps: pairing } = deps('persistent')
    const order: string[] = []
    const put = pairing.store.put
    pairing.store.put = async (record) => {
      order.push(`put:${record.state}`)
      return put(record)
    }
    pairing.saveEnvironment = vi.fn(() => {
      order.push('save')
    })
    await pairWebBrowserWithTicket({
      offer,
      name: 'Studio',
      previousEnvironment: null,
      onComparisonCode: vi.fn(),
      deps: pairing
    })
    expect(order).toEqual(['save', 'put:active'])
  })

  it("gives each attempt its own record, so two tabs with one code never share or remove each other's key", async () => {
    setWebDeviceKeySupportForTests('persistent')
    const { deps: pairing } = deps('persistent', 'denied')
    const created: string[] = []
    const add = pairing.store.add
    pairing.store.add = async (record) => {
      created.push(record.id)
      return add(record)
    }
    // Same host already paired: every attempt keeps the same environment id.
    const previous = createStoredWebRuntimeEnvironment({
      name: 'Studio',
      offer: {
        v: 2,
        endpoint: offer.endpoint,
        deviceToken: 'migrated:old-device',
        publicKeyB64: offer.publicKeyB64,
        scope: 'runtime'
      }
    })
    for (let tab = 0; tab < 2; tab++) {
      await pairWebBrowserWithTicket({
        offer,
        name: 'Studio',
        previousEnvironment: previous,
        onComparisonCode: vi.fn(),
        deps: pairing
      }).catch(() => undefined)
    }
    expect(created).toHaveLength(2)
    expect(created[0]).not.toBe(created[1])
  })
})
