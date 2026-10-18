import { BrowserWindow } from 'electron'
import {
  ORCA_PROFILE_AUTH_STATUS_CHANGED_CHANNEL,
  ORCA_PROFILE_SIGN_IN_LINK_CHANGED_CHANNEL
} from '../../shared/orca-profiles'

function broadcast(channel: string, ...args: unknown[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send(channel, ...args)
    } catch {
      // A renderer can disappear between isDestroyed() and send().
    }
  }
}

export function broadcastOrcaProfileAuthStatusChanged(): void {
  broadcast(ORCA_PROFILE_AUTH_STATUS_CHANGED_CHANNEL)
}

export function broadcastOrcaProfileSignInLinkChanged(link: string | null): void {
  broadcast(ORCA_PROFILE_SIGN_IN_LINK_CHANGED_CHANNEL, link)
}
