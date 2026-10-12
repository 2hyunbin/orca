import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const uiTerminalAndSessionTabsApi = {
  onFocusTerminal: (
    callback: (data: {
      tabId: string
      worktreeId: string
      leafId?: string | null
      ackPaneKeyOnSuccess?: string
      flashFocusedPane?: boolean
      scrollToBottomIfOutputSinceLastView?: boolean
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        tabId: string
        worktreeId: string
        leafId?: string | null
        ackPaneKeyOnSuccess?: string
        flashFocusedPane?: boolean
        scrollToBottomIfOutputSinceLastView?: boolean
      }
    ) => callback(data)
    ipcRenderer.on('ui:focusTerminal', listener)
    return () => ipcRenderer.removeListener('ui:focusTerminal', listener)
  },
  onFocusEditorTab: (
    callback: (data: {
      tabId: string
      worktreeId: string
      /** The user clicked a notification, so revealing the tab is navigation and not a courtesy. */
      userInitiated?: boolean
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { tabId: string; worktreeId: string; userInitiated?: boolean }
    ) => callback(data)
    ipcRenderer.on('ui:focusEditorTab', listener)
    return () => ipcRenderer.removeListener('ui:focusEditorTab', listener)
  }
} satisfies Partial<PreloadApi['ui']>
