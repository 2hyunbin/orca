import { ipcRenderer } from 'electron'

const correlation = crypto.randomUUID()
let closed = false
let port: MessagePort | null = null
let settle: (page: string | null) => void = () => {}
const ready = new Promise<string | null>((resolve) => {
  settle = resolve
})

ipcRenderer.on(
  'pty:rendererPageTransport',
  (event, reply: { correlation?: unknown; page?: unknown }) => {
    if (
      closed ||
      port ||
      reply?.correlation !== correlation ||
      typeof reply.page !== 'string' ||
      event.ports.length !== 1
    ) {
      for (const endpoint of event.ports) {
        endpoint.close()
      }
      return
    }
    port = event.ports[0] ?? null
    port?.start()
    settle(reply.page)
  }
)

// The listener must exist before main can return the document's endpoint.
ipcRenderer.send('pty:openRendererPage', { correlation })

export async function dispatchRendererPage<T>(dispatch: (page: string) => T): Promise<Awaited<T>> {
  const page = await ready
  if (closed || !page) {
    throw new Error('Terminal connection ended with its document')
  }
  return dispatch(page)
}

export function sendRendererPage(channel: string, args: Record<string, unknown>): void {
  void dispatchRendererPage((page) => ipcRenderer.send(channel, { ...args, page })).catch(() => {})
}

// Main, workspace-space and dashboard-popout windows cannot cache isolated preloads and restrict document navigation.
window.addEventListener('pagehide', () => {
  closed = true
  settle(null)
  port?.close()
})
