import { configureRemoteServerUpdater } from '../runtime/remote-server-updater'
import {
  getRemoteServerUpdaterSnapshot,
  checkForRemoteServerUpdate,
  downloadRemoteServerUpdate,
  installRemoteServerUpdate
} from '../updater'

export function configureElectronRemoteServerUpdater(): void {
  configureRemoteServerUpdater({
    getSnapshot: getRemoteServerUpdaterSnapshot,
    check: checkForRemoteServerUpdate,
    download: downloadRemoteServerUpdate,
    install: installRemoteServerUpdate
  })
}
