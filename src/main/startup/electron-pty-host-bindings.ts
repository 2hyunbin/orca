import { ipcMain, MessageChannelMain, powerMonitor } from 'electron'
import { setPtyHostBindings } from '../ipc/pty-host-bindings'

export function installElectronPtyHostBindings(): void {
  setPtyHostBindings({
    ipc: ipcMain,
    power: powerMonitor,
    createMessageChannel: () => new MessageChannelMain()
  })
}
