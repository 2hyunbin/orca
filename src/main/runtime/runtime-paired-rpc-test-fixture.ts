import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { RemoteRuntimeRequestConnection } from '../../shared/remote-runtime-request-connection'
import { parsePairingCode } from '../../shared/pairing'
import type { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeCapability } from '../../shared/protocol-version'
export async function pairedRuntimeRpcFixture(
  cleanups: (() => Promise<void> | void)[],
  runtime: OrcaRuntimeService,
  userDataPath: string,
  scope: 'runtime' | 'mobile' = 'runtime'
) {
  const rpc = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath,
    enableWebSocket: true,
    wsPort: 0
  })
  cleanups.push(() => rpc.stop())
  await rpc.start()
  const offer = rpc.createPairingOffer({ name: 'owned-runtime-fixture', scope })
  if (!offer.available) {
    throw new Error('pairing unavailable')
  }
  const pairing = parsePairingCode(offer.pairingUrl)
  if (!pairing) {
    throw new Error('invalid pairing')
  }
  const connect = (capabilities: readonly RuntimeCapability[] = []) => {
    const connection = new RemoteRuntimeRequestConnection(
      pairedRuntimeConnectionFromOffer(pairing),
      capabilities
    )
    cleanups.push(() => connection.close())
    return connection
  }
  return { runtime, rpc, pairing, connect }
}
