/**
 * The bridge's own IPC channels, and the live collaborators it runs with.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
import { ipcMain, type BrowserWindow } from 'electron'
import { LEGACY_RELAY_BRIDGE_CHANNELS as CHANNELS } from '../../../shared/legacy-relay-bridge-contract'
import type { Store } from '../../persistence'
import { track } from '../../telemetry/client'
import type { SshConnection } from '../ssh-connection'
import { knownSshHostPlatform } from '../ssh-host-platform-memo'
import { hostProps } from '../ssh-host-server-telemetry'
import {
  attachLegacyRelayPane,
  detachLegacyRelayPane,
  installLegacyRelayBridge,
  legacyRelayBridgedPanes,
  resizeLegacyRelayPane,
  terminalsBucket,
  writeLegacyRelayPane
} from './legacy-relay-bridge-registry'

function stringField(value: unknown, field: string): string | null {
  const read: unknown =
    typeof value === 'object' && value !== null ? Reflect.get(value, field) : undefined
  return typeof read === 'string' && read.length > 0 && read.length <= 4096 ? read : null
}

function sizeField(value: unknown, field: string): number | null {
  const read: unknown =
    typeof value === 'object' && value !== null ? Reflect.get(value, field) : undefined
  return typeof read === 'number' && Number.isInteger(read) && read > 0 && read <= 10_000
    ? read
    : null
}

export function registerLegacyRelayBridgeIpc(args: {
  store: Pick<Store, 'getSshRemotePtyLeases' | 'markSshRemotePtyLease'>
  getMainWindow: () => BrowserWindow | null
  connection: (targetId: string) => SshConnection | null
}): void {
  const send = (channel: string, payload: unknown): void => {
    const contents = args.getMainWindow()?.webContents
    if (contents && !contents.isDestroyed()) {
      contents.send(channel, payload)
    }
  }
  installLegacyRelayBridge({
    leases: (targetId) => args.store.getSshRemotePtyLeases(targetId),
    retireLease: (targetId, relayPtyId) =>
      args.store.markSshRemotePtyLease(targetId, relayPtyId, 'terminated'),
    connection: args.connection,
    onPanesChanged: (panes) => send(CHANNELS.panes, panes),
    onData: (ptyId, data) => send(CHANNELS.data, { ptyId, data }),
    onExit: (ptyId, code) => send(CHANNELS.exit, { ptyId, code }),
    report: (targetId, phase, terminals) => {
      try {
        track('ssh_host_server_legacy_relay_bridge', {
          phase,
          terminals: terminalsBucket(terminals),
          ...hostProps(knownSshHostPlatform(targetId))
        })
      } catch {
        // Telemetry never costs a terminal.
      }
    }
  })
  ipcMain.removeHandler(CHANNELS.listPanes)
  ipcMain.removeHandler(CHANNELS.attach)
  for (const channel of [CHANNELS.write, CHANNELS.resize, CHANNELS.detach]) {
    ipcMain.removeAllListeners(channel)
  }
  ipcMain.handle(CHANNELS.listPanes, () => legacyRelayBridgedPanes())
  ipcMain.handle(CHANNELS.attach, async (_event, payload: unknown) => {
    const ptyId = stringField(payload, 'ptyId')
    return ptyId ? attachLegacyRelayPane(ptyId) : { status: 'not-bridged' }
  })
  ipcMain.on(CHANNELS.write, (_event, payload: unknown) => {
    const ptyId = stringField(payload, 'ptyId')
    const data: unknown =
      typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'data') : undefined
    if (ptyId && typeof data === 'string') {
      writeLegacyRelayPane(ptyId, data)
    }
  })
  ipcMain.on(CHANNELS.resize, (_event, payload: unknown) => {
    const ptyId = stringField(payload, 'ptyId')
    const cols = sizeField(payload, 'cols')
    const rows = sizeField(payload, 'rows')
    if (ptyId && cols && rows) {
      resizeLegacyRelayPane(ptyId, cols, rows)
    }
  })
  ipcMain.on(CHANNELS.detach, (_event, payload: unknown) => {
    const ptyId = stringField(payload, 'ptyId')
    if (ptyId) {
      detachLegacyRelayPane(ptyId)
    }
  })
}
