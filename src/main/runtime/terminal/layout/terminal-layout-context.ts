import type { RuntimeStore } from '../../runtime-store-contract'
import type { RuntimeNotifier } from '../../runtime-notifier-contract'
import type { RuntimePtyController } from '../../runtime-pty-controller-contract'
import type { RuntimeTerminalDriverController } from '../../runtime-terminal-driver-controller'
import type { RemoteDesktopTerminalFloor } from '../../remote-desktop-terminal-floor'
import type { RuntimeTerminalViewSubscribers } from '../../runtime-terminal-view-subscribers'
import type { TerminalLayoutState } from './terminal-layout-state'
import type { TerminalLayoutCommands } from './terminal-layout-commands'

export type TerminalFitOverride = {
  mode: 'mobile-fit'
  cols: number
  rows: number
  previousCols: number | null
  previousRows: number | null
  updatedAt: number
  clientId: string
}

export type TerminalLayoutHost = {
  getStore(): Pick<RuntimeStore, 'getSettings' | 'updateSettings'> | null
  getNotifier(): Pick<
    RuntimeNotifier,
    'terminalDriverChanged' | 'terminalFitOverrideChanged'
  > | null
  getPtyController(): Pick<RuntimePtyController, 'resize' | 'attach'> | null
  getTerminalSize(ptyId: string): { cols: number; rows: number } | null | undefined
  resizeHeadlessTerminal(ptyId: string, cols: number, rows: number): void
  notifyRemoteTerminalViewPresenceChanged(ptyId: string): void
  isUnattachedLocalCandidate(ptyId: string): boolean
}

export type TerminalLayoutContext = {
  readonly state: TerminalLayoutState
  readonly host: TerminalLayoutHost
  readonly commands: TerminalLayoutCommands
  readonly drivers: RuntimeTerminalDriverController
  readonly remoteDesktopFloor: RemoteDesktopTerminalFloor
  readonly viewSubscribers: RuntimeTerminalViewSubscribers
}
