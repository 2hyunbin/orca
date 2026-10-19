import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import { isMainWindowPtyIpcEvent } from '../ipc/write-input'
import type { PtyRendererDelivery } from '../session'

/**
 * The one lifetime fence for renderer attachments: each page load mints an id in
 * its preload and opens it before any claim. Only the open switches pages, only
 * from the window's live main frame; a commit, crash or destroy retires the page.
 * In memory only, never persisted or sent to a host.
 */
let current: string | null = null
let navigatingFrom: string | null = null
// Why null-init + wrapper fn: see debug.ts — rolldown const-folds `export let fn = noop` bridges (STA-5661).
let retireImpl: ((page: string) => void) | null = null

export function setRendererPageRetireHandler(fn: ((page: string) => void) | null): void {
  retireImpl = fn
}

/** A detached or vanished frame is a page that already navigated away. */
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

export function openRendererPage(
  event: IpcMainEvent,
  mainWindow: PtyRendererDelivery | undefined,
  page: unknown
): void {
  if (typeof page !== 'string' || !page || !isLiveMainFrameSender(event, mainWindow)) {
    return
  }
  if (current !== page) {
    retireCurrentRendererPage()
    current = page
  }
}

/** Claims act only for the open page; an unknown id never becomes current here. */
export function isAdmittedRendererPage(
  event: IpcMainEvent | IpcMainInvokeEvent,
  mainWindow: PtyRendererDelivery | undefined,
  page: unknown
): page is string {
  return typeof page === 'string' && page === current && isLiveMainFrameSender(event, mainWindow)
}

/** Until commit the old page is still live, and a cancelled navigation keeps it. */
export function noteRendererNavigationStart(): void {
  navigatingFrom = current
}

export function noteRendererNavigationCommit(): void {
  if (current !== null && current === navigatingFrom) {
    retireCurrentRendererPage()
  }
  navigatingFrom = null
}

export function retireCurrentRendererPage(): void {
  const page = current
  navigatingFrom = null
  if (page === null) {
    return
  }
  current = null
  retireImpl?.(page)
}

export function _resetRendererPageForTest(): void {
  current = null
  navigatingFrom = null
}
