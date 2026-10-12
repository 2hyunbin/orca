import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { resolveAdvertisedPairingEndpoint } from '../runtime/pairing-endpoint'
import { assertServeProjectRoot, renderServePairingQr } from './serve-pairing-output'
import type { ServeReadiness, ServeReadinessOutput } from './serve-readiness'
import { SERVE_SUPERVISED_ENV } from '../../shared/serve-bundle-coordination'

/** Endpoint and pairing-offer fields shared by the Electron serve host and orcad. */
export async function buildServePairingReadiness(
  options: {
    pairingAddress?: string | null
    noPairing?: boolean
    mobilePairing?: boolean
    grantDesktopControl?: boolean
  },
  rpc: Pick<OrcaRuntimeRpcServer, 'getWebSocketEndpoint' | 'createPairingOffer'>
): Promise<Pick<ServeReadiness, 'boundEndpoint' | 'advertisedEndpoint' | 'pairing'>> {
  const boundEndpoint = rpc.getWebSocketEndpoint()
  const advertised = boundEndpoint
    ? resolveAdvertisedPairingEndpoint(boundEndpoint, options.pairingAddress)
    : null
  const offer = options.noPairing
    ? ({
        available: false,
        reason: 'disabled_by_operator',
        guidance: 'Restart without --no-pairing to create a client pairing offer.'
      } as const)
    : rpc.createPairingOffer({
        address: options.pairingAddress,
        name: `${options.mobilePairing ? 'Mobile' : 'CLI'} ${new Date().toLocaleDateString()}`,
        scope: options.mobilePairing ? 'mobile' : 'runtime',
        grants: options.grantDesktopControl ? ['desktop-control'] : []
      })

  return {
    boundEndpoint,
    advertisedEndpoint: advertised?.ok ? advertised.endpoint : null,
    pairing: offer.available
      ? {
          available: true,
          url: offer.pairingUrl,
          endpoint: offer.endpoint,
          deviceId: offer.deviceId,
          webClientUrl: offer.webClientUrl,
          scope: options.mobilePairing ? 'mobile' : 'runtime',
          qr: options.mobilePairing ? await renderServePairingQr(offer.pairingUrl) : null
        }
      : offer
  }
}

export function servePublishMode(
  options: {
    recipeJson?: boolean
    projectRoot?: string | null
    json?: boolean
  },
  output: { supervised: boolean; stdoutIsTty: boolean } = {
    supervised: process.env[SERVE_SUPERVISED_ENV] === '1',
    stdoutIsTty: process.stdout.isTTY === true
  }
): ServeReadinessOutput {
  if (options.recipeJson && options.projectRoot) {
    return { mode: 'recipe-json', projectRoot: assertServeProjectRoot(options.projectRoot) }
  }
  if (options.json) {
    return { mode: 'json' }
  }
  // Why only supervised: scripts read `Pairing URL:` from piped stdout of a plain `orca serve`.
  return output.supervised && !output.stdoutIsTty
    ? { mode: 'human', hidePairingUrl: true }
    : { mode: 'human' }
}
