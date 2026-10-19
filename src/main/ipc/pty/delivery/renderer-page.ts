import { randomUUID } from 'node:crypto'
import type { IpcMainEvent, IpcMainInvokeEvent, MessagePortMain } from 'electron'
import { createPtyMessageChannel } from '../../pty-host-bindings'
import { isMainWindowPtyIpcEvent } from '../ipc/write-input'
import type { PtyRendererDelivery } from '../session'

// Each retained endpoint owns exactly its document's connections, independently of navigation.
const pages = new Map<
  string,
  { port: MessagePortMain; contents: PtyRendererDelivery['webContents'] }
>()
// Why null-init + wrapper fn: see debug.ts — rolldown const-folds mutable noop bridges.
let retireImpl: ((page: string) => void) | null = null

export function setRendererPageRetireHandler(fn: ((page: string) => void) | null): void {
  retireImpl = fn
}

function isLiveMainFrameSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
  mainWindow: PtyRendererDelivery | undefined
): boolean {
  if (!isMainWindowPtyIpcEvent(event, mainWindow)) {
    return false
  }
  const frame = event.senderFrame
  return Boolean(frame) && !frame?.detached && frame?.parent === null
}

function retireRendererPage(page: string): void {
  const owner = pages.get(page)
  if (!owner) {
    return
  }
  pages.delete(page)
  owner.port.close()
  retireImpl?.(page)
}

export function openRendererPage(
  event: IpcMainEvent,
  mainWindow: PtyRendererDelivery | undefined,
  correlation: unknown
): void {
  if (
    typeof correlation !== 'string' ||
    !correlation ||
    !isLiveMainFrameSender(event, mainWindow)
  ) {
    return
  }
  const frame = event.senderFrame
  if (!frame) {
    return
  }
  const { port1, port2 } = createPtyMessageChannel()
  const page = randomUUID()
  pages.set(page, { port: port1, contents: event.sender })
  port1.on('close', () => retireRendererPage(page))
  port1.start()
  try {
    frame.postMessage('pty:rendererPageTransport', { correlation, page }, [port2])
  } catch {
    port2.close()
    retireRendererPage(page)
  }
}

/** Unknown or closed tokens cannot admit connections, even from the same frame. */
export function isAdmittedRendererPage(
  event: IpcMainEvent | IpcMainInvokeEvent,
  mainWindow: PtyRendererDelivery | undefined,
  page: unknown
): page is string {
  return (
    typeof page === 'string' &&
    pages.get(page)?.contents === event.sender &&
    isLiveMainFrameSender(event, mainWindow)
  )
}

export function retireRendererPages(contents: PtyRendererDelivery['webContents']): void {
  for (const [page, owner] of pages) {
    if (owner.contents === contents) {
      retireRendererPage(page)
    }
  }
}

export function _resetRendererPageForTest(): void {
  for (const page of pages.keys()) {
    retireRendererPage(page)
  }
}
