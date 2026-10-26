import type { IpcMain } from 'electron'

export type SshInvokeHandler = Parameters<IpcMain['handle']>[1]
export type SshEventHandler = Parameters<IpcMain['on']>[1]
export type SshIpcRegistrar = {
  handle: IpcMain['handle']
  on: (channel: string, handler: SshEventHandler) => void
  removeHandler: IpcMain['removeHandler']
  removeAllListeners: (channel?: string) => void
}

export function createSshIpcRegistration() {
  const handlers = new Map<string, SshInvokeHandler>()
  const listeners = new Map<string, SshEventHandler>()
  const ipc: SshIpcRegistrar = {
    handle: (channel, handler) => {
      handlers.set(channel, handler)
    },
    on: (channel, handler) => {
      listeners.set(channel, handler)
      return ipc
    },
    removeHandler: (channel) => {
      handlers.delete(channel)
    },
    removeAllListeners: (channel) => {
      if (channel) {
        listeners.delete(channel)
      }
      return ipc
    }
  }
  return { ipc, handlers, listeners }
}
