import { getAppEnvironment } from '../../shared/app-environment'
import { admitConnectorAgent, CONNECTOR_AGENTS } from '../external-conversations/connector-agents'
import { runtimeConversationHost } from '../external-conversations/external-conversation-seam'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import { ConnectorCloud } from './connector-cloud'
import { resolveConnectorOrigin } from './connector-origin'
import { connectorProjects, type ConnectorPlacesStore } from './connector-places'
import type { ConnectorMachine } from './connector-poll-client'

export type ConnectorCloudStore = ConnectorPlacesStore &
  Pick<RuntimeStore, 'getSettings' | 'onSettingsChanged'>

/** Electron-free, so desktop, Electron serve and orcad install the same link. */
export function installConnectorCloud(
  runtime: OrcaRuntimeService,
  store: ConnectorCloudStore,
  userDataPath: string,
  hostRuntime: ConnectorMachine['runtime']
): void {
  const environment = getAppEnvironment()
  runtime.setConnectorCloud(
    new ConnectorCloud({
      userDataPath,
      origin: resolveConnectorOrigin(process.env, environment.isPackaged()),
      machine: {
        runtime: hostRuntime,
        orcaVersion: environment.getVersion(),
        seam: () => runtime.getExternalConversationSeam(),
        conversationHost: () => runtimeConversationHost(runtime),
        agents: () =>
          CONNECTOR_AGENTS.filter((agent) => admitConnectorAgent(store.getSettings(), agent)),
        projects: () => connectorProjects(store),
        onConnectorsToggled: (listener) => {
          store.onSettingsChanged?.((updates) => {
            if ('experimentalConnectors' in updates) {
              listener()
            }
          })
        }
      }
    })
  )
}

/** Called once startup is done (proxy applied, runtime ready), so the first poll never races it. */
export function connectConnectorCloud(
  runtime: Pick<OrcaRuntimeService, 'getConnectorCloud'>
): void {
  runtime.getConnectorCloud()?.connect()
}
