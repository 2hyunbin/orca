import { app } from 'electron'
import { startRuntimeEnvironmentAgentAlerts } from '../ipc/runtime-environments/runtime-environment-agent-alerts'
import { getOrcaPushGatewayUrl } from '../orca-profiles/profile-cloud-auth-config'
import { DesktopPushService } from '../runtime/push/desktop-push-service'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { mainProcessState as state } from './main-process-state'

// Host-key authentication also supports accountless hosts.
export function startDesktopPushService(runtimeRpc: OrcaRuntimeRpcServer): void {
  const runtime: OrcaRuntimeService | null = state.runtime
  if (!runtime) {
    console.warn('[push] Background push startup skipped: runtime not started')
    return
  }
  try {
    const pushService = DesktopPushService.create({
      runtime,
      runtimeRpc,
      gatewayUrl: getOrcaPushGatewayUrl()
    })
    pushService?.start()
    const stopSources = startRuntimeEnvironmentAgentAlerts(runtime)
    app.once('will-quit', stopSources)
    state.desktopPushService = pushService
  } catch (error) {
    console.warn(
      '[push] Background push startup unavailable:',
      error instanceof Error ? error.message : String(error)
    )
  }
}
