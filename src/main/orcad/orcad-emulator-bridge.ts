import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrcadRuntimeCleanup } from './orcad-runtime-lifetime'
import { EmulatorBridge } from '../emulator/emulator-bridge'

/** Android drives adb/emulator on any host; iOS backends report their own host-support errors. */
export function installOrcadEmulatorBridge(
  runtime: OrcaRuntimeService,
  registerCleanup: (cleanup: OrcadRuntimeCleanup) => void
): void {
  const bridge = new EmulatorBridge()
  runtime.setEmulatorBridge(bridge)
  // Like desktop quit: stop the helpers and devices Orca started.
  registerCleanup(() => bridge.destroyAllSessions())
}
