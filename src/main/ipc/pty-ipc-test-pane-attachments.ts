import type { TestRendererPort } from './pty-ipc-test-page-port'
import { onMock } from './pty-ipc-mock-registry'

/** Models the renderer preload for pane connects: one open page and one connection record per pane PTY. */
export const TEST_RENDERER_PAGE = 'test-renderer-page'

type Listener = (event: unknown, args: unknown) => unknown

const keyByPty = new Map<string, string>()
let nextKey = 1
let page = TEST_RENDERER_PAGE
let port: TestRendererPort | null = null
let pageContents: unknown = null

export function resetTestPaneAttachments(): void {
  port = null
  pageContents = null
  keyByPty.clear()
  nextKey = 1
  page = TEST_RENDERER_PAGE
}

function listenerFor(channel: string): Listener {
  const call = onMock.mock.calls.find((entry: unknown[]) => entry[0] === channel)
  if (!call) {
    throw new Error(`missing ${channel} listener`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: found by channel name, so this is the listener production registered for it.
  return call[1] as Listener
}

export type TestAttachmentArgs = Readonly<Record<string, unknown>>

/** One attachment message from the current test page, as the preload sends it. */
export function sendTestAttachment(
  event: unknown,
  channel: string,
  args: TestAttachmentArgs
): void {
  listenerFor(channel)(event, { page, ...args })
}

/** The record key the suite's pane connection holds for `ptyId`. */
export function getTestPaneKey(ptyId: string): string | undefined {
  return keyByPty.get(ptyId)
}

/** A spawn without its own record arrives as a pane connect would: visible unless declared hidden. */
export function withTestPaneAttachment(handler: Listener, mainWindowIpcEvent: unknown): Listener {
  return async (event, args) => {
    if (typeof args !== 'object' || args === null || 'rendererAttachment' in args) {
      return handler(event ?? mainWindowIpcEvent, args)
    }
    const hidden = 'initiallyHidden' in args && args.initiallyHidden === true
    const key = `spawn-${nextKey++}`
    const rendererAttachment = { page, key, consuming: !hidden, visible: !hidden }
    const reply = await handler(event ?? mainWindowIpcEvent, { ...args, rendererAttachment })
    if (
      typeof reply === 'object' &&
      reply !== null &&
      'id' in reply &&
      typeof reply.id === 'string'
    ) {
      keyByPty.set(reply.id, key)
    }
    return reply
  }
}

/** The pane connection for `ptyId` reports its state; a PTY no spawn attached opens a record first. */
export function reportTestPaneAttachment(
  mainWindowIpcEvent: unknown,
  event: unknown,
  ptyId: string,
  state: { consuming?: boolean; visible?: boolean }
): void {
  const key = keyByPty.get(ptyId)
  if (key) {
    sendTestAttachment(event ?? mainWindowIpcEvent, 'pty:updateRendererAttachment', {
      key,
      ...state
    })
    return
  }
  keyByPty.set(ptyId, `pane-${ptyId}`)
  sendTestAttachment(event ?? mainWindowIpcEvent, 'pty:openRendererAttachment', {
    key: `pane-${ptyId}`,
    ptyId,
    consuming: true,
    visible: false,
    ...state
  })
}

export function createTestRendererFrame(contents: unknown) {
  return {
    parent: null,
    detached: false,
    postMessage: (_channel: string, reply: { page: string }, ports: TestRendererPort[]) => {
      pageContents = contents
      page = reply.page
      port = ports[0] ?? null
    }
  }
}

export function closeTestRendererPage(): void {
  port?.close()
  port = null
}

/** Opens the test page from `webContents`' live main frame; returns that frame's IPC event. */
export function openTestWindowPage(webContents: unknown): unknown {
  const event = { sender: webContents, senderFrame: createTestRendererFrame(webContents) }
  if (!port || pageContents !== webContents) {
    listenerFor('pty:openRendererPage')(event, { correlation: 'test-open' })
  }
  return event
}

/** A pane already shows `ptyId` in `webContents`' page: a consuming, visible connection. */
export function attachTestPaneView(webContents: unknown, ptyId: string): void {
  const event = openTestWindowPage(webContents)
  reportTestPaneAttachment(event, event, ptyId, { consuming: true, visible: true })
}

/** A new page load opens its own page; the old page's records are retired with it. */
export function openTestRendererPage(mainWindowIpcEvent: unknown, nextPage: string): void {
  keyByPty.clear()
  closeTestRendererPage()
  listenerFor('pty:openRendererPage')(mainWindowIpcEvent, { correlation: nextPage })
}

export function getTestRendererPage(): string {
  return page
}

export function getTestPageTransport() {
  return { page, port }
}
